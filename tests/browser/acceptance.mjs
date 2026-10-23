import { fileURLToPath } from 'node:url'
import { createBrowserFixture } from './fixture.mjs'
import { computeTotpCode } from '../../apps/api/src/auth.ts'

const loginForm = '[data-login-form]'

export async function runBrowserAcceptance({ chromium, expect }) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 20000 })
  const outcomes = []
  const axePath = fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))

  async function scenario(id, title, action, options = {}) {
    const outcome = { id, title, status: 'running', observations: [] }
    const started = Date.now()
    let panel
    let context
    let lastStep = 'fixture'
    const pageErrors = []
    const record = (step, observation = {}) => { lastStep = step; outcome.observations.push({ step, ...observation }) }
    try {
      panel = await createBrowserFixture()
      context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.setDefaultNavigationTimeout(15000)
      page.on('pageerror', error => pageErrors.push(error.name))
      await action({ page, panel, context, record })
      record('served_javascript', { page_errors: pageErrors.length })
      expect(pageErrors, 'Served JavaScript must execute without browser exceptions').toEqual([])
      outcome.status = 'passed'
    } catch (error) {
      // Locator errors, DOM snapshots, request bodies, traces and screenshots can contain credentials.
      // Persist only controlled observations, never Playwright's raw error or page content.
      outcome.status = 'failed'
      outcome.failure = { step: lastStep, error_kind: error?.name ?? 'Error', ...(typeof error?.matcherResult?.name === 'string' ? { assertion: error.matcherResult.name } : {}) }
    } finally {
      await context?.close()
      await panel?.close()
      outcome.page_errors = pageErrors
      outcome.duration_ms = Date.now() - started
      outcomes.push(outcome)
    }
  }

  async function submit(page, form, endpoint, record) {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST'),
      page.locator(`${form} button[type="submit"]`).click(),
    ])
    record(endpoint, { status: response.status(), json_request: response.request().headers()['content-type']?.includes('application/json') === true })
    expect(response.request().headers()['content-type']).toContain('application/json')
    return response
  }

  async function login(page, username, password, record, code = {}) {
    await page.locator('#login-username').fill(username)
    await page.locator('#login-password').fill(password)
    if (code.totp) await page.locator('#login-otp').fill(code.totp)
    if (code.recovery) await page.locator('#login-recovery-code').fill(code.recovery)
    return submit(page, loginForm, '/api/auth/login', record)
  }

  async function accessibility(page, record) {
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
      return result.violations.filter(item => item.impact === 'critical' || item.impact === 'serious').map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }))
    })
    record('axe_serious_critical', { theme: await page.locator('html').getAttribute('data-theme'), violations })
    expect(violations, 'Visible authentication and unavailable surfaces must have no serious or critical axe violations').toEqual([])
  }

  try {
    for (const locale of ['en', 'ar']) {
      await scenario(`BR-LOGIN-${locale.toUpperCase()}`, `JSON login failure remains inline and localized (${locale})`, async ({ page, panel, record }) => {
        const anonymousResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/whm')
        await page.goto(`${panel.baseUrl}/whm?lang=${locale}`)
        const protectedResponse = await anonymousResponse
        record('anonymous_admin_html_redirect', { status: protectedResponse.status(), destination: new URL(page.url()).pathname })
        expect(protectedResponse.status()).toBe(303)
        expect(new URL(page.url()).pathname).toBe('/login')
        await page.goto(`${panel.baseUrl}/login?lang=${locale}`)
        record('runtime_initialized')
        await expect(page.locator('#xpanel-login-client')).toHaveCount(1)
        const response = await login(page, 'root', 'IncorrectBrowserFixturePassword!', record)
        expect(response.status()).toBe(401)
        await expect(page.locator('[data-auth-error]')).toBeVisible()
        expect(new URL(page.url()).pathname).toBe('/login')
        const errorText = await page.locator('[data-auth-error]').innerText()
        expect(locale === 'ar' ? /[\u0600-\u06ff]/.test(errorText) : errorText.length > 0).toBe(true)
        if (locale === 'ar') {
          expect(await page.locator('html').getAttribute('dir')).toBe('rtl')
          const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, digits: /[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText) }))
          record('arabic_mobile_layout', layout)
          expect(layout.content).toBeLessThanOrEqual(layout.width + 1)
          expect(layout.digits).toBe(false)
          const alignment = await page.locator('#login-username').evaluate(input => {
            const style = getComputedStyle(input)
            const inputRect = input.getBoundingClientRect()
            const labelRect = document.querySelector('label[for="login-username"]').getBoundingClientRect()
            return { direction: style.direction, text_align: style.textAlign, field_right: inputRect.right, label_right: labelRect.right }
          })
          record('arabic_field_value_alignment', alignment)
          expect(alignment.direction).toBe('ltr')
          expect(alignment.text_align).toBe('right')
          expect(Math.abs(alignment.field_right - alignment.label_right)).toBeLessThanOrEqual(1)
        }
        await accessibility(page, record)
        await page.goto(`${panel.baseUrl}/login?lang=${locale}&theme=light`)
        record('light_theme_login_loaded')
        await accessibility(page, record)
      }, { mobile: locale === 'ar' })
    }

    await scenario('BR-ROOT-BOOTSTRAP', 'Root changes the bootstrap password, opens the workspace without MFA, enrolls from the security page, then returns to password-only after disable-2fa', async ({ page, panel, context, record }) => {
      const bootstrap = await panel.rootState()
      record('persisted_bootstrap_state', bootstrap)
      expect(bootstrap).toEqual({ exists: true, force_password_change: true, mfa_enabled: false })
      await page.goto(`${panel.baseUrl}/login?target=xwhm`)
      expect((await login(page, 'root', panel.rootPassword, record)).status()).toBe(200)
      await expect(page.locator('[data-auth-password-form]')).toBeVisible()
      const restricted = await page.evaluate(async () => (await fetch('/api/accounts')).status)
      record('bootstrap_session_restricted', { status: restricted })
      expect(restricted).toBe(403)
      await page.locator('[data-auth-password-form] [name="currentPassword"]').fill(panel.rootPassword)
      await page.locator('[data-auth-password-form] [name="newPassword"]').fill(panel.replacementPassword)
      await page.locator('[data-auth-password-form] [name="confirmPassword"]').fill(panel.replacementPassword)
      expect((await submit(page, '[data-auth-password-form]', '/api/auth/change-password', record)).status()).toBe(200)
      await expect(page.locator(loginForm)).toBeVisible()
      expect((await login(page, 'root', panel.replacementPassword, record)).status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/whm')
      record('password_only_workspace', { path: new URL(page.url()).pathname })
      await expect(page.locator('[data-mfa-optional-link]')).toBeVisible()
      await expect(page.locator('[data-auth-setup-form]')).toHaveCount(0)
      await page.goto(`${panel.baseUrl}/whm/security/sign-in`)
      await expect(page.locator('[data-mfa-recommendation]')).toBeVisible()
      await accessibility(page, record)
      await expect(page.locator('[data-action="setup-2fa"]')).toBeVisible()
      await page.locator('#enrollment-password').fill(panel.replacementPassword)
      const [setup] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/2fa/setup'),
        page.locator('[data-action="setup-2fa"]').click(),
      ])
      record('mfa_setup', { status: setup.status() })
      expect(setup.status()).toBe(200)
      await expect(page.locator('[data-auth-enrollment-details]')).toBeVisible()
      await expect(page.locator('[data-auth-totp-qr] > svg'), 'Enrollment QR code is rendered').toBeVisible()
      const secret = (await page.locator('[data-auth-totp-secret]').innerText()).trim()
      expect(/^[A-Z2-7]{16,}$/.test(secret), 'Enrollment secret is presented in the actual UI').toBe(true)
      const code = computeTotpCode(secret)
      const issuedAt = Date.now()
      await page.locator('[data-auth-enroll-form] [name="code"]').fill(code)
      expect((await submit(page, '[data-auth-enroll-form]', '/api/auth/2fa/enable', record)).status()).toBe(200)
      await expect(page.locator('[data-auth-recovery-codes] li')).toHaveCount(8)
      const recoveryText = await page.locator('[data-auth-recovery-codes]').innerText()
      const recoveryCodes = recoveryText.match(/\b[0-9a-f]{32}\b/g) ?? []
      record('recovery_codes_presented', { count: recoveryCodes.length })
      expect(recoveryCodes.length, 'Recovery codes are displayed once before acknowledgement').toBe(8)
      await page.locator('[data-action="acknowledge-recovery"]').click()
      record('recovery_codes_acknowledged')
      await page.waitForURL(url => url.pathname === '/whm/security/sign-in')
      await expect(page.locator('[data-mfa-enabled="true"]')).toBeVisible()
      await page.goto(`${panel.baseUrl}/whm`)
      const enrolled = await panel.rootState()
      record('persisted_enrolled_state', enrolled)
      expect(enrolled).toEqual({ exists: true, force_password_change: false, mfa_enabled: true })
      await expect(page.locator('[data-tool-availability="unverified"]')).toBeVisible()
      expect(await page.locator('[data-tool-availability="unverified"] form').count()).toBe(0)
      expect((await page.locator('body').innerText()).includes(secret)).toBe(false)
      const sessionCookies = (await context.cookies()).filter(cookie => cookie.name.endsWith('xpanel_session'))
      record('session_cookie', { count: sessionCookies.length, http_only: sessionCookies[0]?.httpOnly, same_site: sessionCookies[0]?.sameSite })
      expect(sessionCookies.length).toBe(1)
      expect(sessionCookies[0].httpOnly).toBe(true)
      expect(sessionCookies[0].sameSite).toBe('Strict')
      const before = (await panel.store.listFeatureLists()).length
      const csrf = await page.evaluate(async () => (await fetch('/api/feature-lists', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'invalid-browser-csrf' }, body: JSON.stringify({ name: 'Must remain absent', ownerId: null, disabled: [] }) })).status)
      record('invalid_csrf', { status: csrf })
      expect(csrf).toBe(403)
      expect((await panel.store.listFeatureLists()).length).toBe(before)
      await accessibility(page, record)
      const [logout] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST'),
        page.locator('[data-action="logout"]').click(),
      ])
      record('ui_logout', { status: logout.status(), json_request: logout.request().headers()['content-type']?.includes('application/json') === true })
      expect(logout.status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/login')
      expect(await page.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401)
      expect((await login(page, 'root', panel.replacementPassword, record)).status()).toBe(401)
      await expect(page.locator('#login-otp')).toBeVisible()
      record('used_totp_still_in_acceptance_window', { elapsed_ms: Date.now() - issuedAt })
      expect(Date.now() - issuedAt).toBeLessThan(30000)
      const replay = await login(page, 'root', panel.replacementPassword, record, { totp: code })
      expect(replay.status()).toBe(401)
      await expect(page.locator('[data-auth-error]')).toBeVisible()
      await page.locator('#login-otp').fill('')
      const recovery = await login(page, 'root', panel.replacementPassword, record, { recovery: recoveryCodes[0] })
      expect(recovery.status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/whm')
      record('replay_denied_and_recovery_login_completed')
      await page.goto(`${panel.baseUrl}/login?target=xwhm`)
      await panel.disableRoot2fa()
      const disabled = await panel.rootState()
      record('persisted_disabled_state', disabled)
      expect(disabled).toEqual({ exists: true, force_password_change: false, mfa_enabled: false })
      expect((await login(page, 'root', panel.replacementPassword, record)).status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/whm')
      await expect(page.locator('[data-mfa-optional-link]')).toBeVisible()
      record('disable_2fa_restored_password_login')
    })

    await scenario('BR-OWNER-SCOPE', 'An account owner signs in through the UI and cannot open the administrative HTML surface', async ({ page, panel, record }) => {
      await page.goto(`${panel.baseUrl}/login?target=xpanel&lang=ar`)
      expect((await login(page, 'browserowner', panel.ownerPassword, record)).status()).toBe(200)
      record('owner_redirect_pending')
      await page.waitForURL(url => url.pathname === '/panel')
      record('owner_workspace_loaded', { path: new URL(page.url()).pathname })
      await expect(page.locator('[data-tool-availability="unverified"]')).toBeVisible()
      await accessibility(page, record)
      await expect(page.locator('#xpanel-login-client')).toHaveCount(1)
      const deniedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/whm' && response.request().resourceType() === 'document')
      let blockedDocument = false
      await page.goto(`${panel.baseUrl}/whm`).catch(error => {
        // Chromium can reject rendering a forbidden document while still receiving its HTTP 403.
        if (!error.message.includes('net::ERR_HTTP_RESPONSE_CODE_FAILURE')) throw error
        blockedDocument = true
      })
      const denied = await deniedResponse
      record('owner_admin_html_denied', { status: denied.status(), chromium_blocked_document: blockedDocument })
      expect(denied.status()).toBe(403)
    })

    await scenario('BR-ASSETS-AND-SURFACES', 'Static client assets serve with strict MIME/nosniff headers, reject traversal, and enforce surface HTML guards', async ({ page, panel, record }) => {
      const loginJs = await page.request.get(`${panel.baseUrl}/assets/login.js`)
      const wsJs = await page.request.get(`${panel.baseUrl}/assets/ws.js`)
      record('static_assets_served', {
        login_status: loginJs.status(),
        login_ct: loginJs.headers()['content-type'],
        login_nosniff: loginJs.headers()['x-content-type-options'],
        ws_status: wsJs.status(),
        ws_ct: wsJs.headers()['content-type'],
      })
      expect(loginJs.status()).toBe(200)
      expect(loginJs.headers()['content-type']).toContain('javascript')
      expect(loginJs.headers()['x-content-type-options']).toBe('nosniff')
      expect((await loginJs.text()).length).toBeGreaterThan(64)
      expect(wsJs.status()).toBe(200)
      expect(wsJs.headers()['content-type']).toContain('javascript')
      expect(wsJs.headers()['x-content-type-options']).toBe('nosniff')

      const missingAsset = await page.request.get(`${panel.baseUrl}/assets/nonexistent-bundle.js`)
      const traversalAsset = await page.request.get(`${panel.baseUrl}/assets/%2e%2e/package.json`)
      record('static_asset_denials', { missing_status: missingAsset.status(), traversal_status: traversalAsset.status() })
      expect(missingAsset.status()).toBe(404)
      expect([400, 403, 404]).toContain(traversalAsset.status())

      await page.goto(`${panel.baseUrl}/login?target=xpanel&lang=en`)
      expect((await login(page, 'browserowner', panel.ownerPassword, record)).status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/panel')
      await page.goto(`${panel.baseUrl}/mail?lang=en`)
      record('owner_webmail_surface_loaded', { path: new URL(page.url()).pathname })
      expect(new URL(page.url()).pathname).toBe('/mail')
      await accessibility(page, record)
    })

    await scenario('BR-RTL-BILINGUAL-UX', 'Arabic RTL surfaces enforce zero horizontal overflow at 1440x900 and 360x800, ASCII 0-9 digits, LTR technical isolation, and keyboard focus', async ({ page, panel, record }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${panel.baseUrl}/login?target=xpanel&lang=ar`)
      expect((await login(page, 'browserowner', panel.ownerPassword, record)).status()).toBe(200)
      await page.waitForURL(url => url.pathname === '/panel')

      for (const vp of [{ width: 1440, height: 900, label: 'desktop_1440' }, { width: 360, height: 800, label: 'mobile_360' }]) {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        const metrics = await page.evaluate(() => {
          const html = document.documentElement
          const easternDigits = /[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText)
          const ltrNodes = [...document.querySelectorAll('bdi[dir="ltr"], [dir="ltr"], code')].slice(0, 10)
          const allLtrComputed = ltrNodes.every(el => getComputedStyle(el).direction === 'ltr')
          return {
            dir: html.getAttribute('dir'),
            lang: html.getAttribute('lang'),
            innerWidth: window.innerWidth,
            scrollWidth: html.scrollWidth,
            easternDigits,
            ltrNodeCount: ltrNodes.length,
            allLtrComputed,
          }
        })
        record(`rtl_geometry_${vp.label}`, metrics)
        expect(metrics.dir).toBe('rtl')
        expect(metrics.lang).toBe('ar')
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
        expect(metrics.easternDigits).toBe(false)
        expect(metrics.allLtrComputed).toBe(true)
      }

      await page.keyboard.press('Tab')
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')
      record('keyboard_tab_focus', { focused_tag: focusedTag })
      expect(focusedTag).not.toBe('BODY')
      expect(focusedTag).not.toBe('NONE')
      await accessibility(page, record)
    })
  } finally {
    await browser.close()
  }
  return { browser: { name: 'chromium', version: browser.version() }, environment: 'real Chromium + loopback API + explicit fake host fixture', limitations: ['No Linux workload, host service, TLS transport, storage quota or production isolation proof.', 'Automated axe checks are not a complete accessibility certification.', 'Service management tools remain unverified; this suite does not certify account-creation UI or the unavailable 35 feature workflows.'], outcomes }
}
