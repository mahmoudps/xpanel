import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp } from '../../apps/web/src/app.ts'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const states = ['en', 'ar'].flatMap(locale => ['light', 'dark'].flatMap(theme => [360, 768, 1440].flatMap(width => ['accounts', 'create'].map(screen => ({ id: screen + '-' + locale + '-' + theme + '-' + width, locale, theme, width, screen })))))
const plan = defaultPlan({ id: 'fixture-plan', name: 'Standard', featureListId: 'fixture-features' })
const alpha = { id: 'internal-alpha', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', ipv6: '2001:db8::10', extraIps: ['192.0.2.11'], shell: 'jailed', createdAt: '2026-10-23T00:00:00Z' }
const beta = { ...alpha, id: 'internal-beta', username: 'beta', primaryDomain: 'beta.example.test', status: 'suspended' }
const principal = { kind: 'root', id: 'fixture-root', username: 'operator' }
const catalog = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic browser fixture only.', evidence: [] } }))

function fingerprint(destination, phase) {
  const files = [...new Set([...collectSnapshotFiles(root), 'tests/browser/accounts-acceptance.mjs'])].sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const result = { sha256: computeSourceDigest(files), files }
  writeFileSync(join(destination, 'source-' + phase + '.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

async function fixture() {
  const requests = []
  let pendingCreate = null
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/api/auth/me') { res.end(JSON.stringify({ csrfToken: 'synthetic-ui-fixture-csrf' })); return }
      if (url.pathname === '/api/ips' && req.method === 'GET') {
        assert.equal(url.searchParams.get('view'), 'allocation')
        assert.equal(url.searchParams.get('planId'), plan.id)
        res.end(JSON.stringify({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: '10000000-0000-4000-8000-000000000001', address: alpha.ipv4 }, dedicated: { entitled: false, unallocated: [], count: 0 } }))
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      const safeBody = { ...body }; delete safeBody.password
      requests.push({ method: req.method, path: url.pathname, body: safeBody, password_supplied: typeof body.password === 'string', csrf: req.headers['x-csrf-token'], content_type: req.headers['content-type'] })
      if (url.pathname === '/api/accounts' && body.username === 'newowner') await new Promise(resolve => { pendingCreate = resolve })
      await new Promise(resolve => setTimeout(resolve, 80))
      if (url.pathname === '/api/accounts' && body.username === 'stateconflict') {
        res.statusCode = 409
        res.end(JSON.stringify({ code: 'CONFLICT', detail: 'untrusted-host-output', details: { reason: 'state_changed_during_apply', stateChanged: true, verificationRequired: true } }))
      } else if (url.pathname === '/api/accounts' && req.method === 'POST' && body.username !== 'newblocked') {
        res.statusCode = 201
        res.end(JSON.stringify({ account: { ...alpha, username: body.username }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } }))
      } else if (req.method === 'DELETE' || url.pathname === '/api/accounts') {
        res.statusCode = 412
        res.end(JSON.stringify({ code: 'PRECONDITION_FAILED', detail: 'untrusted-private-host-message', details: { verificationRequired: true, stateChanged: false } }))
      } else if (url.pathname.endsWith('/unsuspend')) {
        res.statusCode = 503
        res.end(JSON.stringify({ code: 'PRECONDITION_FAILED', detail: 'untrusted-private-host-message', details: { verificationRequired: true, stateChanged: true, hostOutcome: 'failed' } }))
      } else if (url.pathname.endsWith('/suspend')) {
        res.end(JSON.stringify({ account: { ...alpha, status: 'suspended' }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } }))
      } else { res.statusCode = 404; res.end(JSON.stringify({ code: 'NOT_FOUND' })) }
      return
    }
    const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en'
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
    const role = url.searchParams.get('role')
    const selectedPrincipal = role === 'reseller' ? { kind: 'reseller', id: 'fixture-reseller', username: 'reader' } : principal
    const visibility = { principal: selectedPrincipal, disabledFeatures: new Set(), ...(role === 'reseller' ? { reseller: { acl: ['list-accounts'] } } : {}) }
    const state = { surface: 'xwhm', activeRoute: url.pathname, locale, theme, realtimeEnabled: false, catalog, visibility, whm: { principal: selectedPrincipal, accounts: [alpha, beta], plans: [plan], hostname: 'server.example.test' } }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderWebApp(state).replace('<html ', '<html data-accounts-fixture="synthetic" '))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, requests, releaseCreate: () => { const release = pendingCreate; pendingCreate = null; assert.ok(release, 'A delayed create response must actually be pending'); release() }, close: () => { pendingCreate?.(); return new Promise(resolve => server.close(resolve)) } }
}

async function geometry(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-account-dialog]')
    const fields = [...dialog.querySelectorAll('.xp-accounts__field')].filter(field => !field.hidden).map(field => {
      const label = field.querySelector('dt,label'), value = field.querySelector('dd,input,textarea')
      const a = label.getBoundingClientRect(), b = value.getBoundingClientRect()
      let glyphDelta = null
      if (value.tagName === 'DD') {
        const labelRange = document.createRange(), valueRange = document.createRange()
        labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
        const first = labelRange.getBoundingClientRect(), second = valueRange.getBoundingClientRect()
        glyphDelta = document.dir === 'rtl' ? Math.abs(first.right - second.right) : Math.abs(first.left - second.left)
      }
      return { label: label.textContent, gap: b.top - a.bottom, edge: document.dir === 'rtl' ? Math.abs(a.right - b.right) : Math.abs(a.left - b.left), glyphDelta }
    })
    const controls = [...dialog.querySelectorAll('button,input,textarea')].filter(control => control.checkVisibility()).map(control => {
      const rect = control.getBoundingClientRect()
      return { tag: control.tagName, width: rect.width, height: rect.height }
    })
    const rect = dialog.getBoundingClientRect()
    return { fields, controls, dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, overflow: document.documentElement.scrollWidth - innerWidth, ascii: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText) }
  })
}

async function createAccountGate(page, host, state, result, destination, expect) {
  const form = page.locator('[data-create-account-form]')
  await expect(form).toHaveAttribute('action', '/api/accounts')
  const password = form.locator('[name="password"]')
  assert.equal(await password.getAttribute('type'), 'password')
  const submit = form.locator('button[type="submit"]')
  const fields = await form.evaluate(form => [...form.querySelectorAll('.xp-accounts__field')].map(field => {
    const label = field.querySelector('label'), value = field.querySelector('input,select')
    const a = label.getBoundingClientRect(), b = value.getBoundingClientRect()
    return { gap: b.top - a.bottom, left: Math.abs(a.left - b.left), width: b.width, height: b.height }
  }))
  assert.equal(fields.length, 6)
  assert.ok(await form.evaluate(form => form.getBoundingClientRect().width <= 640.5), 'The single-column form stays within a readable desktop measure')
  for (const field of fields) assert.ok(Math.abs(field.gap - 8) < 1 && field.left < 1 && field.width >= 44 && field.height >= 44)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  result.fields = fields
  await page.screenshot({ path: join(destination, 'screenshots/' + state.id + '-form.png'), fullPage: true })
  const initial = host.requests.length
  await form.locator('[name="username"]').fill('newblocked')
  await form.locator('[name="primaryDomain"]').fill('newblocked.example.test')
  await password.fill('short')
  await submit.click()
  assert.equal(host.requests.length, initial)
  await password.fill('synthetic-' + 'x'.repeat(16))
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/accounts' && response.request().method() === 'POST')
  await submit.click()
  await form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await refused
  await expect(form.locator('[data-account-create-status]')).toContainText(state.locale === 'ar' ? 'غير متاح' : 'unavailable')
  await expect(password).toHaveValue('')
  await expect(password).toBeEnabled()
  await expect(form.locator('[name="username"]')).toBeEnabled()
  await expect(form.locator('[name="username"]')).toHaveValue('newblocked')
  assert.equal(host.requests.length, initial + 1)
  assert.equal(host.requests.at(-1).password_supplied, true)
  assert.equal(host.requests.at(-1).body.password, undefined)
  await form.locator('[name="username"]').fill('newowner')
  await password.fill('synthetic-' + 'y'.repeat(16))
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/accounts' && response.request().method() === 'POST')
  await submit.click()
  for (const control of await form.locator('input,select').all()) await expect(control).toBeDisabled()
  await page.keyboard.type('unsent')
  await expect(form.locator('[name="username"]')).toHaveValue('newowner')
  host.releaseCreate()
  await created
  await expect(form.locator('[data-account-create-status]')).toHaveAttribute('data-state', 'pending')
  await expect(submit).toBeDisabled()
  await expect(password).toHaveValue('')
  await expect(page.locator('#xp-toast-region')).toHaveCount(0)
  await expect(form.locator('[name="username"]')).toHaveAttribute('readonly', '')
  await expect(form.locator('[name="username"]')).toHaveValue('newowner')
  result.requests = host.requests.slice(initial)
  assert.equal(result.requests.length, 2)
  assert.equal(result.requests.every(request => request.path === '/api/accounts' && request.method === 'POST' && request.csrf === 'synthetic-ui-fixture-csrf'), true)
  assert.equal(result.requests.every(request => request.body.ipAssignment?.mode === 'shared' && request.body.ipv4 === undefined && request.body.ipv6 === undefined), true)
  await page.screenshot({ path: join(destination, 'screenshots/' + state.id + '-pending.png'), fullPage: true })
  await page.reload()
  const conflictForm = page.locator('[data-create-account-form]')
  await conflictForm.locator('[name="username"]').fill('stateconflict')
  await conflictForm.locator('[name="primaryDomain"]').fill('stateconflict.example.test')
  await conflictForm.locator('[name="password"]').fill('synthetic-' + 'z'.repeat(16))
  const uncertain = page.waitForResponse(response => new URL(response.url()).pathname === '/api/accounts' && response.request().method() === 'POST')
  await conflictForm.locator('button[type="submit"]').click(); await uncertain
  await expect(conflictForm.locator('[data-account-create-status]')).toContainText(state.locale === 'ar' ? 'راجع الحسابات' : 'Review accounts before retrying')
  await expect(conflictForm.locator('button[type="submit"]')).toBeDisabled()
  for (const control of await conflictForm.locator('input,select').all()) await expect(control).toBeDisabled()
  const count = host.requests.length
  await conflictForm.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(host.requests.length, count)
  result.requests = host.requests.slice(initial)
  assert.equal(result.requests.length, 3)
  result.delayed_response_identity_preserved = true
  result.unknown_outcome_requires_review = true

}
export async function runAccountsAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim())
  const destination = resolve(root, output || 'test-results/accounts-' + new Date().toISOString().replaceAll(':', '-'))
  const path = relative(root, destination)
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || existsSync(destination)) throw new Error('Choose a new repository-relative output directory')
  const selected = states.filter(state => !filter || state.id.includes(filter))
  assert.ok(selected.length > 0)
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(destination, 'before'), host = await fixture(), outcomes = []
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  const { chromium, expect } = await import('@playwright/test')
  let browser, version
  try {
    const bundled = (() => { try { return chromium.executablePath() } catch { return '' } })()
    const executablePath = [process.env.CHROME_PATH, bundled, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
    browser = await chromium.launch({ headless: true, executablePath, timeout: 20000 })
    version = browser.version()
    for (const state of selected) {
      const result = { ...state, status: 'running', page_errors: [], requests: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: 900 }, reducedMotion: 'reduce', colorScheme: state.theme, locale: state.locale })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.on('pageerror', error => result.page_errors.push(error.message))
      try {
        await page.goto(host.baseUrl + (state.screen === 'create' ? '/whm/accounts/new?lang=' : '/whm/accounts?lang=') + state.locale + '&theme=' + state.theme)
        await page.evaluate(() => document.fonts.ready)
        assert.equal(await page.locator('html').getAttribute('data-accounts-fixture'), 'synthetic')
        result.fonts = await assertAppliedFont(page, 'h1', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
        if (state.screen === 'create') {
          await createAccountGate(page, host, state, result, destination, expect)
        } else {
        assert.equal(await page.locator('[data-board-port="xwhm-accounts"] thead th').count(), 9)
        await page.locator('[data-account-row="beta"] [data-account-menu]').click()
        assert.equal(await page.locator('[data-account-row]').count(), 2)
        await expect(page.locator('[data-account-dialog]')).not.toBeVisible()
        result.fonts = await assertAppliedFont(page, 'h1', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
        await page.screenshot({ path: join(destination, 'screenshots/' + state.id + '-list.png'), fullPage: true })
        const trigger = page.locator('[data-account-row="beta"] [data-action="terminate-account"]')
        await trigger.click()
        const dialog = page.locator('[data-account-dialog]'), input = dialog.locator('[data-type-to-confirm]'), submit = dialog.locator('[data-account-action-submit]'), cancel = dialog.locator('[data-account-action-cancel]')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('[data-account-dialog-username]')).toHaveText('beta')
        await expect(dialog.locator('[data-account-dialog-domain]')).toHaveText('beta.example.test')
        await expect(input).toBeFocused()
        const initial = host.requests.length
        await input.fill('alpha'); await input.press('Enter')
        await expect(submit).toBeDisabled()
        assert.equal(host.requests.length, initial)
        await input.fill('beta')
        await submit.focus(); await page.keyboard.press('Tab'); await expect(input).toBeFocused()
        await page.keyboard.press('Shift+Tab'); await expect(submit).toBeFocused()
        result.geometry = await geometry(page)
        assert.equal(result.geometry.overflow, 0)
        assert.equal(result.geometry.ascii, true)
        assert.ok(result.geometry.dialog.left >= 15 && result.geometry.dialog.right <= state.width - 15)
        assert.ok(Math.abs((result.geometry.dialog.top + result.geometry.dialog.bottom) / 2 - 450) < 1, 'The native dialog must be centered in the actual viewport')
        assert.ok(result.geometry.fields.length >= 3)
        for (const field of result.geometry.fields) { assert.ok(Math.abs(field.gap - 8) < 1, 'The actual field gap is 8px: ' + field.label); assert.ok(field.edge < 1); if (field.glyphDelta !== null) assert.ok(field.glyphDelta < 1) }
        for (const control of result.geometry.controls) assert.ok(control.width >= 43.9 && control.height >= 43.9)
        result.dialogFont = await assertAppliedFont(page, '[data-account-dialog-title]', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
        await page.screenshot({ path: join(destination, 'screenshots/' + state.id + '-dialog.png'), fullPage: true })
        await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused()
        await trigger.click(); await expect(input).toHaveValue('')
        await input.fill('beta')
        const deletion = page.waitForResponse(response => response.request().method() === 'DELETE')
        await submit.click()
        await page.evaluate(() => document.querySelector('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
        await deletion
        await expect(dialog.locator('[data-account-action-status]')).toContainText(state.locale === 'ar' ? 'غير متاح' : 'unavailable')
        await expect(input).toHaveValue('beta')
        assert.equal(host.requests.length, initial + 1)
        assert.deepEqual(host.requests.at(-1).body, { confirmUsername: 'beta' })
        assert.equal(host.requests.at(-1).path, '/api/accounts/internal-beta')
        assert.equal(host.requests.at(-1).content_type, 'application/json')
        assert.equal(host.requests.at(-1).csrf, 'synthetic-ui-fixture-csrf')
        await expect(page.locator('[data-account-row="beta"]')).toBeVisible()
        await expect(page.locator('#xp-toast-region')).toHaveCount(0)
        assert.equal(await dialog.innerText().then(text => text.includes('untrusted-private-host-message')), false)
        await cancel.click()
        await page.locator('[data-account-row="beta"] [data-action="unsuspend-account"]').click()
        const unsuspend = page.waitForResponse(response => response.url().endsWith('/unsuspend'))
        await submit.click(); await unsuspend
        await expect(dialog.locator('[data-account-action-status]')).toContainText(state.locale === 'ar' ? 'تعذر' : 'could not be verified')
        await cancel.click()
        await page.locator('[data-account-row="alpha"] [data-account-menu]').click()
        await page.locator('[data-account-row="alpha"] [data-action="suspend-account"]').click()
        await dialog.locator('[name="reason"]').fill('Synthetic reason')
        const suspension = page.waitForResponse(response => response.url().endsWith('/suspend'))
        await submit.click(); await suspension
        await expect(dialog.locator('[data-account-action-status]')).toHaveAttribute('data-state', 'pending')
        await expect(submit).toBeDisabled()
        await expect(page.locator('[data-account-row="alpha"] [data-account-status]')).toContainText(state.locale === 'ar' ? 'يلزم التحقق' : 'Verification required')
        await cancel.click()
        await expect(page.locator('[data-account-row="alpha"] [data-account-menu]')).toBeFocused()
        await expect(page.locator('[data-account-row="alpha"] [data-account-status].xp-badge')).toHaveAttribute('data-status', 'warn')
        result.requests = host.requests.slice(initial)
        assert.deepEqual(result.requests.map(request => request.method + ' ' + request.path), ['DELETE /api/accounts/internal-beta', 'POST /api/accounts/internal-beta/unsuspend', 'POST /api/accounts/internal-alpha/suspend'])
        }
        assert.deepEqual(result.page_errors, [])
        result.status = 'passed'
      } catch (error) { result.status = 'failed'; result.failure = { name: error.name, message: String(error.message).slice(0, 1400) }; await page.screenshot({ path: join(destination, 'screenshots/' + state.id + '-failure.png'), fullPage: true }).catch(() => {}) }
      finally { await context.close(); outcomes.push(result); process.stdout.write(JSON.stringify({ id: state.id, status: result.status, failure: result.failure?.message }) + '\n') }
    }
  } finally { await browser?.close(); await host.close() }
  const after = fingerprint(destination, 'after'), first = new Map(before.files.map(file => [file.path, file.sha256])), last = new Map(after.files.map(file => [file.path, file.sha256]))
  const drift = [...new Set([...first.keys(), ...last.keys()])].filter(path => first.get(path) !== last.get(path))
  const report = { status: outcomes.every(result => result.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', runtime: process.version, browser: version, tests: { total: outcomes.length, passed: outcomes.filter(result => result.status === 'passed').length, failed: outcomes.filter(result => result.status === 'failed').length }, source: { before: before.sha256, after: after.sha256, drift }, fixture: { synthetic: true, loopback_only: true, mocked_api: true, real_host_mutations: 0, service_qualification: false }, limits: ['This verifies browser behavior against bounded synthetic HTTP responses; real API authorization and lifecycle side effects need independent HTTP/service tests.', 'Configuration application remains unverified hosting work. A 412 deletion refusal does not implement native purge.', 'No catalog capability is promoted by this fixture.'], outcomes }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ status: report.status, tests: report.tests, drift }) + '\n')
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runAccountsAcceptance({ output: process.argv.find(value => value.startsWith('--output='))?.slice(9), filter: process.argv.find(value => value.startsWith('--filter='))?.slice(9) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
