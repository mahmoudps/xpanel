import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp } from '../../apps/web/src/app.ts'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const output = resolve(process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'test-results/ip-allocation-' + new Date().toISOString().replaceAll(':', '-'))
assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim())
assert.equal(existsSync(output), false, 'Use a new evidence directory; preserve previous attempts.')
mkdirSync(join(output, 'screenshots'), { recursive: true })
const ids = { sharedPlan: '10000000-0000-4000-8000-000000000001', dedicatedPlan: '10000000-0000-4000-8000-000000000002', alternatePlan: '10000000-0000-4000-8000-000000000003', shared: '20000000-0000-4000-8000-000000000001', first: '20000000-0000-4000-8000-000000000002', second: '20000000-0000-4000-8000-000000000003', ipv6: '20000000-0000-4000-8000-000000000004' }
const plans = [defaultPlan({ id: ids.dedicatedPlan, name: 'Dedicated', featureListId: '30000000-0000-4000-8000-000000000001' }), defaultPlan({ id: ids.sharedPlan, name: 'Shared', featureListId: '30000000-0000-4000-8000-000000000001' }), defaultPlan({ id: ids.alternatePlan, name: 'Alternate', featureListId: '30000000-0000-4000-8000-000000000001' })]
plans[0].dedicatedIp = true; plans[2].dedicatedIp = true
const principal = { kind: 'root', id: '40000000-0000-4000-8000-000000000001', username: 'operator' }
const catalog = tools.map(tool => tool.status === 'out-of-scope' ? tool : { ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic browser diagnostic only.', evidence: [] } })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function fingerprint() {
  const files = [...new Set([...collectSnapshotFiles(root), 'tests/browser/ip-allocation-acceptance.mjs'])].sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) } })
  return { sha256: computeSourceDigest(files), files }
}
const before = fingerprint()
writeFileSync(join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n')

async function fixture() {
  const requests = [], pending = [], oversized = []
  let scenario = 'normal', sharedAddress = '192.0.2.10', exhausted = false, aborted = 0
  function availability(planId) {
    const entitled = planId !== ids.sharedPlan
    const ipv4 = exhausted || scenario === 'ipv6-only' ? [] : [{ poolId: ids.first, address: '192.0.2.21', version: 4 }, { poolId: ids.second, address: '192.0.2.22', version: 4 }]
    const unallocated = entitled ? [...ipv4, { poolId: ids.ipv6, address: '2001:db8::21', version: 6 }] : []
    return { scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: scenario === 'no-shared' ? null : { poolId: ids.shared, address: planId === ids.alternatePlan ? '192.0.2.12' : sharedAddress }, dedicated: { entitled, unallocated, count: unallocated.length } }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('content-type', 'application/json')
        if (url.pathname === '/api/auth/me') { res.end(JSON.stringify({ csrfToken: 'synthetic-ip-diagnostic-csrf' })); return }
        if (url.pathname === '/api/ips' && req.method === 'GET') {
          assert.equal(url.searchParams.get('view'), 'allocation')
          const planId = url.searchParams.get('planId')
          assert.ok(plans.some(plan => plan.id === planId))
          assert.equal(url.searchParams.has('ownerId'), false)
          requests.push({ method: 'GET', path: url.pathname, planId })
          if (scenario === 'unauthorized' || scenario === 'forbidden') { res.statusCode = scenario === 'unauthorized' ? 401 : 403; res.end(JSON.stringify({ code: 'DIAGNOSTIC_REFUSAL', detail: 'do-not-render-private-response' })); return }
          if (scenario === 'malformed') { res.end(JSON.stringify({ scope: 'host-verified', defaultSharedIpv4: { address: '<script>bad</script>' }, dedicated: { entitled: true, unallocated: [], count: 0 } })); return }
          if (scenario === 'oversized') {
            const observation = { chunksWritten: 0, canceled: false }; oversized.push(observation)
            res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write('{"scope":"')
            let chunks = 0
            const timer = setInterval(() => { if (res.destroyed || ++chunks > 100) { clearInterval(timer); if (!res.destroyed) res.end('"}'); return } observation.chunksWritten++; res.write('x'.repeat(32768)) }, 2)
            res.on('close', () => { observation.canceled = !res.writableEnded; clearInterval(timer) }); return
          }
          if (scenario === 'delayed' || scenario === 'out-of-order' || scenario === 'detached') {
            const payload = availability(planId)
            const item = { planId, res, release() { if (!res.destroyed) res.end(JSON.stringify(payload)) } }
            pending.push(item)
            res.on('close', () => { if (!res.writableEnded) aborted++ })
            return
          }
          res.end(JSON.stringify(availability(planId))); return
        }
        let raw = ''; for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}, safeBody = { ...body }; delete safeBody.password
        requests.push({ method: req.method, path: url.pathname, body: safeBody, passwordSupplied: typeof body.password === 'string', csrf: req.headers['x-csrf-token'], contentType: req.headers['content-type'] })
        if (url.pathname !== '/api/accounts' || req.method !== 'POST') { res.statusCode = 404; res.end(JSON.stringify({ code: 'NOT_FOUND' })); return }
        if (scenario === 'exhausted') { exhausted = true; res.statusCode = 412; res.end(JSON.stringify({ code: 'PRECONDITION_FAILED', details: { reason: 'dedicated_ipv4_unavailable', stateChanged: false } })); return }
        if (scenario === 'uncertain') { res.statusCode = 409; res.end(JSON.stringify({ code: 'CONFLICT', detail: 'do-not-render-private-response', details: { reason: 'dedicated_ip_reserved' } })); return }
        if (scenario === 'post-timeout') return
        if (scenario === 'malformed-ack') { res.statusCode = 201; res.end(JSON.stringify({ account: { username: body.username, ipv4: sharedAddress }, reconcile: { status: 'applied' } })); return }
        const ipv4 = body.ipAssignment.mode === 'shared' ? sharedAddress : body.ipAssignment.poolId === ids.second ? '192.0.2.22' : '192.0.2.21'
        res.statusCode = 201
        res.end(JSON.stringify({ account: { id: '50000000-0000-4000-8000-000000000001', username: body.username, ipv4 }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } }))
        return
      }
      const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en', theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
      const readOnly = url.searchParams.get('role') === 'reader', selectedPrincipal = readOnly ? { kind: 'reseller', id: '60000000-0000-4000-8000-000000000001', username: 'reader' } : principal
      const visibility = { principal: selectedPrincipal, disabledFeatures: new Set(), ...(readOnly ? { reseller: { acl: ['list-accounts'] } } : {}) }
      const state = { surface: 'xwhm', activeRoute: '/whm/accounts/new', locale, theme, realtimeEnabled: false, catalog, visibility, whm: { principal: selectedPrincipal, accounts: [], plans, hostname: 'synthetic.example.test' } }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(renderWebApp(state).replace('<html ', '<html data-ip-fixture="synthetic" '))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ code: 'DIAGNOSTIC_FIXTURE_FAILURE' })); requests.push({ fixtureError: error.message }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port, requests, pending, oversized,
    setScenario(value) { scenario = value; if (value === 'normal') exhausted = false }, setSharedAddress(value) { sharedAddress = value }, get aborted() { return aborted },
    async close() { for (const item of pending) item.release(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
const { chromium, expect } = await import('@playwright/test')
const browser = await chromium.launch({ headless: true }), host = await fixture(), outcomes = []
const states = ['en', 'ar'].flatMap(locale => ['light', 'dark'].flatMap(theme => [360, 1440].map(width => ({ id: 'native-' + [locale, theme, width].join('-'), locale, theme, width, kind: 'native' }))))
for (const kind of ['shared-during-loading', 'shared-after-preview-error', 'dedicated-auto', 'dedicated-specific', 'plan-intent', 'ipv6-only', 'missing-shared', 'out-of-order', 'real-abort', 'detached', 'unauthorized', 'forbidden', 'malformed', 'oversized', 'exhausted', 'uncertain', 'post-timeout', 'malformed-ack', 'read-only']) states.push({ id: kind, kind, locale: 'en', theme: 'light', width: 1440 })
async function fillAccount(page) { await page.locator('#new-acc-username').fill('synthetic'); await page.locator('#new-acc-domain').fill('synthetic.example.test'); await page.locator('#new-acc-password').fill('synthetic-' + 'x'.repeat(16)) }
async function ready(page) { await expect(page.locator('[data-account-ip-status]')).toHaveAttribute('data-state', 'ready') }
const postRequests = () => host.requests.filter(request => request.method === 'POST' && request.path === '/api/accounts')

try {
  for (const state of states) {
    const context = await browser.newContext({ viewport: { width: state.width, height: state.width < 960 ? 900 : 1000 } }), page = await context.newPage(), start = host.requests.length, initialPosts = postRequests().length, result = { ...state, observations: [], pageErrors: [] }
    page.on('pageerror', error => result.pageErrors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    host.setSharedAddress('192.0.2.10'); host.setScenario('normal')
    if (['shared-during-loading', 'real-abort'].includes(state.kind)) host.setScenario('delayed')
    if (['shared-after-preview-error', 'malformed'].includes(state.kind)) host.setScenario('malformed')
    if (['ipv6-only', 'out-of-order', 'detached', 'unauthorized', 'forbidden', 'oversized', 'exhausted', 'uncertain', 'post-timeout', 'malformed-ack'].includes(state.kind)) host.setScenario(state.kind)
    if (state.kind === 'missing-shared') host.setScenario('no-shared')
    if (state.kind === 'out-of-order') await context.addInitScript(() => {
      const realFetch = window.fetch.bind(window); window.__ipDiagnosticSignals = []
      window.fetch = (url, init) => { if (String(url).startsWith('/api/ips?')) { window.__ipDiagnosticSignals.push(init.signal); const settings = { ...init }; delete settings.signal; return realFetch(url, settings) } return realFetch(url, init) }
    })
    try {
      await page.goto(host.baseUrl + '/whm/accounts/new?lang=' + state.locale + '&theme=' + state.theme + (state.kind === 'read-only' ? '&role=reader' : ''), { waitUntil: 'domcontentloaded' })
      assert.equal(await page.locator('html').getAttribute('data-ip-fixture'), 'synthetic')
      const selector = page.locator('#new-acc-ipv4'), submit = page.locator('[data-create-account-form] button[type="submit"]'), feedback = page.locator('[data-account-ip-status]')
      if (state.kind === 'read-only') {
        await expect(page.locator('[data-create-account-form]')).toHaveCount(0)
        assert.equal(host.requests.slice(start).length, 0)
        result.observations.push({ createFormAbsentWithoutPermission: true, ipInventoryRequests: 0 })
      } else {
      assert.equal(await selector.evaluate(element => element.tagName), 'SELECT')
      assert.equal(await selector.getAttribute('aria-describedby'), 'new-acc-ipv4-address new-acc-ipv4-status')
      await expect(page.getByRole('combobox', { name: state.locale === 'ar' ? 'تعيين IPv4' : 'IPv4 assignment', exact: true })).toHaveCount(1)
      assert.equal(await page.locator('[data-create-account-form] input,[data-create-account-form] select').count(), 6)
      await expect(selector).toHaveValue('shared')
      if (state.kind === 'native') {
        await ready(page); await page.evaluate(() => document.fonts.ready)
        result.font = await assertAppliedFont(page, 'h1', state.locale === 'ar' ? 'Noto Sans Arabic' : 'IBM Plex Sans')
        const options = await selector.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, text: element.textContent, disabled: element.disabled })))
        assert.equal(options.length, 4); assert.equal(options.some(option => option.text.includes(':')), false, 'Dedicated IPv6 inventory must not appear as a primary IPv4 choice')
        assert.equal(options.some(option => option.text.includes(ids.first) || option.text.includes(ids.second)), false)
        await expect(page.locator('[data-account-ip-address]')).toHaveText('192.0.2.10')
        await expect(selector).toHaveAccessibleDescription(/192\.0\.2\.10/)
        await page.locator('[data-account-ip-address]').click({ clickCount: 3 })
        assert.equal(await page.evaluate(() => getSelection().toString().trim()), '192.0.2.10', 'The readonly actual address is selectable text')
        const geometry = await page.evaluate(() => {
          const control = document.querySelector('#new-acc-ipv4'), label = document.querySelector('label[for="new-acc-ipv4"]'), preview = document.querySelector('[data-account-ip-address]'), refresh = document.querySelector('[data-account-ip-refresh]'), rtl = document.dir === 'rtl'
          const rect = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect() }, a = rect(label), b = rect(preview), c = control.getBoundingClientRect(), d = refresh.getBoundingClientRect()
          return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, control: { width: c.width, height: c.height }, refresh: { width: d.width, height: d.height }, logicalEdgeDelta: Math.abs(rtl ? a.right - b.right : a.left - b.left), previewDirection: getComputedStyle(preview).direction, previewIsolate: getComputedStyle(preview).unicodeBidi, ascii: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText) }
        })
        assert.ok(geometry.documentWidth <= geometry.width + 1); assert.ok(geometry.control.height >= 44 && geometry.refresh.height >= 44 && geometry.refresh.width >= 44); assert.ok(geometry.logicalEdgeDelta <= 1); assert.equal(geometry.previewDirection, 'ltr'); assert.ok(geometry.previewIsolate.includes('isolate')); assert.equal(geometry.ascii, true)
        result.observations.push({ nativeOptions: options, geometry })
        await selector.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await expect(selector).toHaveValue('dedicated:auto'); await page.keyboard.press('ArrowDown'); await expect(selector).toHaveValue('dedicated:' + ids.first)
        await selector.selectOption('shared'); await page.screenshot({ path: join(output, 'screenshots', state.id + '.png'), fullPage: true })
      } else if (['unauthorized', 'forbidden', 'malformed', 'oversized', 'shared-after-preview-error'].includes(state.kind)) {
        await expect(feedback).toHaveAttribute('data-state', 'failed'); assert.equal((await feedback.textContent()).includes('do-not-render-private-response'), false)
        await expect(selector.locator('option[value="dedicated:auto"]')).toBeDisabled(); await expect(page.locator('[data-account-ip-preview]')).toBeHidden()
        if (state.kind === 'oversized') { await expect.poll(() => host.oversized.at(-1)?.canceled).toBe(true); assert.ok(host.oversized.at(-1).chunksWritten < 100); result.observations.push({ actualChunkedResponseCanceled: true, serverChunksWritten: host.oversized.at(-1).chunksWritten, clientRetainedByteLimit: 1048576 }) }
        if (state.kind === 'shared-after-preview-error') { await fillAccount(page); await submit.click(); await expect(page.locator('[data-account-create-status]')).toHaveAttribute('data-state', 'pending'); assert.deepEqual(postRequests().at(-1).body.ipAssignment, { mode: 'shared' }) }
      } else if (state.kind === 'ipv6-only') {
        await ready(page); await expect(selector.locator('option[value="dedicated:auto"]')).toBeDisabled(); assert.equal(await selector.locator('option').count(), 2)
      } else if (state.kind === 'missing-shared') {
        await expect(feedback).toHaveAttribute('data-state', 'unavailable'); await fillAccount(page); await submit.click(); assert.equal(postRequests().length, initialPosts)
        await selector.selectOption('dedicated:auto'); await expect(feedback).toHaveAttribute('data-state', 'ready')
      } else if (state.kind === 'plan-intent') {
        await ready(page); await selector.selectOption('dedicated:' + ids.second); await page.locator('#new-acc-plan').selectOption(ids.sharedPlan)
        await expect(feedback).toHaveAttribute('data-state', 'unavailable'); await expect(selector).toHaveValue('dedicated:' + ids.second); await expect(selector.locator('option:checked')).toBeDisabled()
        await fillAccount(page); await submit.click(); assert.equal(postRequests().length, initialPosts)
        await page.locator('#new-acc-plan').selectOption(ids.alternatePlan); await ready(page); await expect(selector).toHaveValue('dedicated:' + ids.second); await expect(selector.locator('option:checked')).toBeEnabled(); await expect(page.locator('[data-account-ip-address]')).toHaveText('192.0.2.22')
      } else if (['out-of-order', 'real-abort', 'detached'].includes(state.kind)) {
        await expect.poll(() => host.pending.filter(item => !item.res.writableEnded && !item.res.destroyed).length).toBeGreaterThan(0)
        const old = host.pending.at(-1), oldAbortCount = host.aborted
        if (state.kind === 'detached') {
          await page.evaluate(() => { window.__detachedIpForm = document.querySelector('[data-create-account-form]'); window.__detachedIpForm.remove() }); old.release()
          await expect.poll(() => old.res.writableEnded || old.res.destroyed).toBe(true)
          assert.equal(await page.evaluate(() => window.__detachedIpForm.querySelector('[data-account-ip-status]').getAttribute('data-state')), 'loading')
        } else {
          host.setScenario('normal'); await page.locator('#new-acc-plan').selectOption(ids.alternatePlan); await ready(page); await expect(page.locator('[data-account-ip-address]')).toHaveText('192.0.2.12')
          if (state.kind === 'out-of-order') {
            assert.equal(await page.evaluate(() => window.__ipDiagnosticSignals[0].aborted), true)
            const delivered = page.waitForResponse(response => response.url().includes('/api/ips?') && new URL(response.url()).searchParams.get('planId') === ids.dedicatedPlan)
            old.release(); await delivered; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            await expect(page.locator('[data-account-ip-address]')).toHaveText('192.0.2.12'); result.observations.push({ adversarialSignalIgnoredForDelivery: true, oldSignalAborted: true, staleResponseIgnored: true })
          } else { await expect.poll(() => host.aborted).toBeGreaterThan(oldAbortCount); result.observations.push({ actualAbortedResponse: true }) }
        }
      } else {
        if (state.kind === 'shared-during-loading') await expect(feedback).toHaveAttribute('data-state', 'loading')
        else await ready(page)
        if (['dedicated-auto', 'exhausted', 'uncertain'].includes(state.kind)) await selector.selectOption('dedicated:auto')
        if (state.kind === 'dedicated-specific') { await selector.selectOption('dedicated:' + ids.second); await page.locator('#new-acc-ipv6').fill('2001:db8::22') }
        await fillAccount(page)
        if (state.kind === 'shared-during-loading') host.setSharedAddress('192.0.2.13')
        const submittedAt = Date.now()
        await submit.click(); await page.locator('[data-create-account-form]').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
        if (state.kind === 'exhausted') {
          await expect(page.locator('[data-account-create-status]')).toHaveAttribute('data-state', 'failed'); await expect(feedback).toHaveAttribute('data-state', 'unavailable'); await expect(selector).toHaveValue('dedicated:auto'); await expect(selector.locator('option:checked')).toBeDisabled(); await expect(page.locator('#new-acc-password')).toHaveValue('')
        } else if (['uncertain', 'post-timeout', 'malformed-ack'].includes(state.kind)) {
          await expect(page.locator('[data-account-create-status]')).toContainText('Review accounts before retrying', { timeout: state.kind === 'post-timeout' ? 25000 : 5000 }); await expect(submit).toBeDisabled(); await expect(selector).toBeDisabled(); await expect(page.locator('[data-account-ip-refresh]')).toBeDisabled()
          if (state.kind === 'post-timeout') { const elapsed = Date.now() - submittedAt; assert.ok(elapsed >= 19500 && elapsed < 26000); result.observations.push({ actualSessionTransportTimeoutMs: elapsed, automaticRetry: false }) }
        } else {
          await expect(page.locator('[data-account-create-status]')).toHaveAttribute('data-state', 'pending'); await expect(submit).toBeDisabled(); await expect(page.locator('#xp-toast-region')).toHaveCount(0)
          const request = postRequests().at(-1), expected = state.kind === 'dedicated-specific' ? { mode: 'dedicated', poolId: ids.second } : state.kind === 'dedicated-auto' ? { mode: 'dedicated' } : { mode: 'shared' }
          assert.deepEqual(request.body.ipAssignment, expected); assert.equal(request.body.ipv4, undefined); assert.equal(request.body.ipv6, state.kind === 'dedicated-specific' ? '2001:db8::22' : undefined); assert.equal(request.csrf, 'synthetic-ip-diagnostic-csrf'); assert.match(request.contentType, /application\/json/); assert.equal(request.passwordSupplied, true)
          if (state.kind === 'shared-during-loading') await expect(page.locator('[data-account-ip-address]')).toHaveText('192.0.2.13')
          result.observations.push({ payload: request.body, actualResponseShown: true, hostVerified: false })
        }
        assert.equal(postRequests().length, initialPosts + 1, 'Duplicate submit must not issue another create request')
      }
      }
      assert.equal(result.pageErrors.length, 0); assert.equal(host.requests.slice(start).some(request => request.fixtureError), false)
      result.requests = host.requests.slice(start); result.status = 'passed'
    } catch (error) { result.status = 'failed'; result.error = { name: error.name, message: error.message }; await page.screenshot({ path: join(output, 'screenshots', state.id + '-failure.png'), fullPage: true }).catch(() => {}) }
    outcomes.push(result); await context.close(); for (const item of host.pending) item.release()
    writeFileSync(join(output, 'results.partial.json'), JSON.stringify({ outcomes }, null, 2) + '\n')
  }
} finally { await browser.close(); await host.close() }
const after = fingerprint(), drift = before.files.filter(file => file.sha256 !== after.files.find(candidate => candidate.path === file.path)?.sha256).map(file => file.path)
writeFileSync(join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n')
const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), status: outcomes.every(outcome => outcome.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', scope: 'Synthetic real Chromium IPv4 assignment form diagnostics only. GET options and POST replies are explicit loopback fixtures; no real principal authorization, writer lease, address reservation, Linux binding, hosting availability or release qualification is proven.', runtime: process.version, browser: browser.version(), tests: { total: outcomes.length, passed: outcomes.filter(outcome => outcome.status === 'passed').length, failed: outcomes.filter(outcome => outcome.status === 'failed').length }, source: { before: before.sha256, after: after.sha256, drift }, outcomes }
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, tests: report.tests, drift, failures: outcomes.filter(outcome => outcome.status === 'failed').map(outcome => ({ id: outcome.id, error: outcome.error })) }))
process.exitCode = report.status === 'passed' ? 0 : 1
