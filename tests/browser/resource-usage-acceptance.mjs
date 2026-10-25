import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { renderThresholdMeter, renderWebApp, renderWhmSurface, renderMailSurface, serveStaticAsset } from '../../apps/web/src/index.ts'
import { tools } from '../../packages/catalog/src/index.ts'
import { assertAppliedFont } from './applied-font-contract.mjs'

// Component fixtures only: no authentication, service measurements or capability qualification.
const cases = [
  { id: 'measured-zero', used: 0, limit: 100, kind: 'bounded', threshold: 'ok' },
  { id: 'bounded', used: 64, limit: 100, kind: 'bounded', threshold: 'ok' },
  { id: 'warning', used: 85, limit: 100, kind: 'bounded', threshold: 'warn' },
  { id: 'critical', used: 97, limit: 100, kind: 'bounded', threshold: 'critical' },
  { id: 'over-limit', used: 250, limit: 100, kind: 'bounded', threshold: 'critical' },
  { id: 'unlimited', used: 42, limit: 'unlimited', kind: 'unlimited' },
  { id: 'zero-empty', used: 0, limit: 0, kind: 'zero-limit' },
  { id: 'zero-exceeded', used: 7, limit: 0, kind: 'zero-limit', threshold: 'critical' },
  { id: 'missing-usage', used: undefined, limit: 100, kind: 'unavailable' },
  { id: 'missing-cap', used: 7, limit: undefined, kind: 'unavailable' },
  { id: 'unbounded-allocation', used: 'unlimited', limit: 100, kind: 'unbounded-allocation', threshold: 'critical' },
]
const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const output = resolve(arg('--output') ?? 'test-results/resource-usage')
if (existsSync(output)) throw new Error('Preserve earlier evidence and choose a fresh output directory.')
mkdirSync(join(output, 'screenshots'), { recursive: true })
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const { default: axe } = await import('axe-core')
const inputs = ['packages/core/src/rules/resource-usage.ts', 'packages/core/src/rules/index.ts', 'packages/core/src/types.ts', 'apps/web/src/app.ts', 'apps/web/src/shell.ts', 'apps/web/src/i18n.ts', 'apps/web/src/mail-layout.ts', 'apps/web/src/tokens.ts', 'apps/web/src/charts.ts', 'apps/web/src/surfaces/xwhm.ts', 'apps/web/src/surfaces/xmail.ts', 'apps/web/src/surfaces/xpanel.ts', 'apps/web/src/ws-client.ts', 'tests/browser/resource-usage-acceptance.mjs']
const fingerprint = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const before = fingerprint(), outcomes = [], surfaceOutcomes = []
const syntheticCatalog = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Diagnostic resource-rendering fixture only; no capability qualification.', evidence: [] } }))
const html = (locale, theme, density, surface = '/') => {
  const isAr = locale === 'ar', name = isAr ? 'استخدام الموارد' : 'Resource usage'
  const base = renderWebApp({ surface: 'login', locale, theme, density })
  if (surface !== '/') {
    const principal = surface === '/resellers' ? { kind: 'root', id: 'resource-fixture-root', username: 'fixture-root' } : { kind: 'user', id: 'resource-fixture-owner', username: 'fixture-owner', accountId: 'resource-fixture-account' }
    const common = { locale, theme, realtimeEnabled: false, visibility: { principal, disabledFeatures: new Set() }, catalog: syntheticCatalog }
    const markup = surface === '/resellers'
      ? renderWhmSurface({ ...common, principal, activeRoute: '/whm/resellers', hostname: 'fixture.example.test', resellers: [
        { id: 'fixture-reseller-1', username: 'fixture-one', acl: [], maxAccounts: 5, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: false, nameservers: [], delegatedIps: [] },
        { id: 'fixture-reseller-2', username: 'fixture-two', acl: [], maxAccounts: 'unlimited', totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] },
      ] })
      : renderMailSurface({ ...common, mailbox: 'fixture-owner@example.test', quotaUsedMb: 7, activeRoute: '/mail/overview', messages: [] })
    return base.slice(0, base.indexOf('<body>')).replace('data-surface="login"', `data-surface="${surface === '/resellers' ? 'xwhm' : 'xmail'}"`) + `<body data-visual-fixture="synthetic"><div role="note" class="xp-help" style="padding:8px 16px;text-align:center" dir="ltr">Synthetic resource surface fixture</div>${markup}</body></html>`
  }
  const cards = cases.map(item => `<section class="xp-card" data-usage-case="${item.id}"><div class="xp-field"><span class="xp-label" data-resource-label>${isAr ? 'الذاكرة' : 'Memory'}</span>${renderThresholdMeter(item.used, item.limit, { locale, unit: 'MiB', label: `${name} ${item.id}` })}</div></section>`).join('')
  return base.slice(0, base.indexOf('<body>')) + `<body data-visual-fixture="synthetic"><div role="note" class="xp-help" style="padding:8px 16px;text-align:center" dir="ltr">Synthetic component fixture</div><main class="resource-preview"><h1>${name}</h1><div class="resource-preview-grid">${cards}</div></main><style>.resource-preview{padding:var(--xp-space-card);display:flex;flex-direction:column;gap:var(--xp-space-card)}.resource-preview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:var(--xp-space-card)}@media(max-width:480px){.resource-preview{padding:var(--xp-space-field)}}</style></body></html>`
}
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); request.resume(); response.end(); return }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const asset = serveStaticAsset(url.pathname)
  if (asset) { response.writeHead(asset.status, Object.fromEntries(asset.headers)); response.end(request.method === 'HEAD' ? undefined : Buffer.from(await asset.arrayBuffer())); return }
  if (!['/', '/resellers', '/mail-unknown-cap'].includes(url.pathname)) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(request.method === 'HEAD' ? undefined : html(url.searchParams.get('lang') === 'ar' ? 'ar' : 'en', url.searchParams.get('theme') === 'dark' ? 'dark' : 'light', url.searchParams.get('density') === 'compact' ? 'compact' : 'comfortable', url.pathname))
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true })
try {
  for (const locale of ['en', 'ar']) for (const theme of ['light', 'dark']) for (const width of [360, 768, 1440]) for (const density of ['comfortable', 'compact']) {
    const id = [locale, theme, width, density].join('-'), outcome = { id, locale, theme, width, density, synthetic: true, checks: [], errors: [] }
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }), page = await context.newPage()
    page.on('pageerror', error => outcome.errors.push(error.message))
    const check = (name, condition, observed) => outcome.checks.push({ name, passed: Boolean(condition), observed })
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (!['GET', 'HEAD'].includes(request.method()) || ![new URL(origin).host, 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.host)) return route.abort()
      return route.continue()
    })
    try {
      await page.goto(`${origin}/?lang=${locale}&theme=${theme}&density=${density}`, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      outcome.font = await assertAppliedFont(page, 'h1', locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
      outcome.geometry = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width } }
        const glyph = element => { const range = document.createRange(); range.selectNodeContents(element); const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
        const rtl = document.documentElement.dir === 'rtl'
        return {
          documentWidth: document.documentElement.scrollWidth, bodyOverflow: getComputedStyle(document.body).overflowX, rootOverflow: getComputedStyle(document.documentElement).overflowX,
          states: [...document.querySelectorAll('[data-usage-case]')].map(card => {
            const label = card.querySelector('[data-resource-label]'), group = card.querySelector('.xp-meter'), values = group.querySelector('.xp-meter__values bdi'), meter = group.querySelector('[role="meter"]')
            const labelGlyph = glyph(label), valueGlyph = glyph(values)
            const numbers = [], walker = document.createTreeWalker(values, NodeFilter.SHOW_TEXT); let node
            while (node = walker.nextNode()) for (const match of node.textContent.matchAll(/\d+(?:\.\d+)?/g)) { const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); const r = range.getBoundingClientRect(); numbers.push({ value: match[0], left: r.left, top: r.top }) }
            const usedGlyph = glyph(group.querySelector('[data-resource-part="used"]')), limitGlyph = glyph(group.querySelector('[data-resource-part="limit"]'))
            return { id: card.dataset.usageCase, kind: group.dataset.resourceState, threshold: group.dataset.threshold, text: group.textContent, percentage: group.querySelector('.xp-meter__fill')?.getAttribute('style'), gap: rect(group).top - rect(label).bottom, logicalEdgeDelta: Math.abs(rtl ? labelGlyph.right - valueGlyph.right : labelGlyph.left - valueGlyph.left), usedGlyph, limitGlyph, numbers, meter: meter ? { label: meter.getAttribute('aria-label'), min: Number(meter.getAttribute('aria-valuemin')), max: Number(meter.getAttribute('aria-valuemax')), value: Number(meter.getAttribute('aria-valuenow')), text: meter.getAttribute('aria-valuetext') } : null }
          }),
        }
      })
      check('document-contained-without-concealment', outcome.geometry.documentWidth <= width + 1 && !['clip', 'hidden'].includes(outcome.geometry.bodyOverflow) && !['clip', 'hidden'].includes(outcome.geometry.rootOverflow), outcome.geometry)
      for (const item of cases) {
        const observed = outcome.geometry.states.find(state => state.id === item.id)
        check(item.id + '-semantic-state', observed.kind === item.kind && observed.threshold === item.threshold, observed)
        check(item.id + '-alignment-and-gap', observed.logicalEdgeDelta <= 1 && Math.abs(observed.gap - 8) <= 0.5, { gap: observed.gap, edge: observed.logicalEdgeDelta })
        check(item.id + '-whole-LTR-ratio', observed.numbers.every((number, i, all) => i === 0 || Math.abs(number.top - all[i - 1].top) > 1 || number.left >= all[i - 1].left), observed.numbers)
        check(item.id + '-actual-used-before-limit-glyphs', observed.usedGlyph.right <= observed.limitGlyph.left + 0.5 && Math.abs(observed.usedGlyph.top - observed.limitGlyph.top) <= 1, { used: observed.usedGlyph, limit: observed.limitGlyph })
        check(item.id + '-ascii-digits', !/[\u0660-\u0669\u06f0-\u06f9]/.test(observed.text), observed.text)
        if (item.kind === 'bounded') check(item.id + '-honest-accessible-meter', observed.meter?.label && observed.meter.min === 0 && observed.meter.max === item.limit && observed.meter.value === Math.min(item.used, item.limit) && observed.meter.text.includes(String(item.used)), observed.meter)
        else check(item.id + '-no-fictitious-meter', !observed.meter && !observed.percentage && !/\d+%/.test(observed.text), observed)
      }
      await page.addScriptTag({ content: axe.source })
      outcome.accessibility = await page.evaluate(async () => { const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }); return { violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) })) } })
      check('WCAG-no-violations', outcome.accessibility.violations.length === 0, outcome.accessibility)
      check('no-page-errors', outcome.errors.length === 0, outcome.errors)
      outcome.status = outcome.checks.every(check => check.passed) ? 'passed' : 'failed'
    } catch (error) { outcome.status = 'failed'; outcome.error = { name: error.name, message: error.message } }
    outcome.screenshot = 'screenshots/' + id + '.png'
    await page.screenshot({ path: join(output, outcome.screenshot), fullPage: true }); outcomes.push(outcome)
    writeFileSync(join(output, 'results.partial.json'), JSON.stringify({ outcomes }, null, 2) + '\n')
    await context.close()
    if (outcomes.length % 4 === 0) console.log(JSON.stringify({ completedViews: outcomes.length, failedViews: outcomes.filter(item => item.status !== 'passed').length }))
  }
  for (const surface of ['resellers', 'mail-unknown-cap']) for (const [locale, theme, width] of [['en', 'light', 1440], ['ar', 'dark', 360]]) {
    const id = [surface, locale, theme, width].join('-'), outcome = { id, surface, locale, theme, width, synthetic: true, checks: [], errors: [] }
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }), page = await context.newPage()
    page.on('pageerror', error => outcome.errors.push(error.message))
    const check = (name, condition, observed) => outcome.checks.push({ name, passed: Boolean(condition), observed })
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (!['GET', 'HEAD'].includes(request.method()) || ![new URL(origin).host, 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.host)) return route.abort()
      return route.continue()
    })
    try {
      const response = await page.goto(`${origin}/${surface}?lang=${locale}&theme=${theme}`, { waitUntil: 'networkidle' })
      assert.equal(response.status(), 200)
      await page.evaluate(() => document.fonts.ready)
      outcome.font = await assertAppliedFont(page, 'h1', locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
      outcome.geometry = await page.evaluate(() => {
        const readMeter = group => group ? ({ kind: group.dataset.resourceState, used: group.querySelector('[data-resource-part="used"]').textContent, limit: group.querySelector('[data-resource-part="limit"]').textContent, hasBar: Boolean(group.querySelector('[role="meter"], .xp-meter__fill')), value: group.querySelector('.xp-meter__values').textContent, text: group.textContent }) : null
        return {
          documentWidth: document.documentElement.scrollWidth, bodyOverflow: getComputedStyle(document.body).overflowX, rootOverflow: getComputedStyle(document.documentElement).overflowX,
          meters: [...document.querySelectorAll('.xp-meter')].map(readMeter),
          nativeResellers: [...document.querySelectorAll('[data-reseller-row]')].map(row => ({ username: row.dataset.resellerRow, meters: [...row.querySelectorAll('.xp-meter')].map(readMeter) })),
          resellerDetails: [...document.querySelectorAll('[data-reseller-detail]')].map(detail => ({
            username: detail.querySelector('summary').textContent.trim(),
            capacities: ['maxAccounts', 'totalDiskMb', 'totalBandwidthMb'].map(name => {
              const input = detail.querySelector(`input[name="${name}"]`), group = input?.closest('.xp-reseller-groups')
              return { name, value: input?.value, label: input?.labels[0]?.textContent.trim(), unlimited: detail.querySelector(`input[name="${name}Unlimited"]`)?.checked, meter: readMeter(group?.querySelector('.xp-meter')) }
            }),
          })),
        }
      })
      check('actual-surface-document-contained-without-concealment', outcome.geometry.documentWidth <= width + 1 && !['hidden', 'clip'].includes(outcome.geometry.bodyOverflow) && !['hidden', 'clip'].includes(outcome.geometry.rootOverflow), outcome.geometry)
      check('unknown-values-have-no-meter-or-healthy-state', outcome.geometry.meters.length > 0 && outcome.geometry.meters.every(meter => meter.kind === 'unavailable' && !meter.hasBar && !/Healthy|Within limit|ضمن الحد/.test(meter.text)), outcome.geometry.meters)
      if (surface === 'resellers') {
        const unknown = locale === 'ar' ? 'غير متاح' : 'Unavailable', unlimited = locale === 'ar' ? 'غير محدود' : 'Unlimited'
        const honestUnknown = meter => meter?.kind === 'unavailable' && meter.used === unknown && !meter.hasBar && !/Healthy|Within limit|ضمن الحد/.test(meter.text)
        const nativeContracts = [{ username: 'fixture-one', limits: ['5', '10'], units: [locale === 'ar' ? 'حسابات' : 'accounts', 'GiB'] }, { username: 'fixture-two', limits: [unlimited, unlimited], units: [locale === 'ar' ? 'حسابات' : 'accounts', 'GiB'] }]
        check('reseller-native-configured-caps-preserved', outcome.geometry.nativeResellers.length === nativeContracts.length && nativeContracts.every(expected => {
          const rows = outcome.geometry.nativeResellers.filter(row => row.username === expected.username), row = rows[0]
          return rows.length === 1 && row.meters.length === 2 && row.meters.every((meter, index) => honestUnknown(meter) && meter.limit === expected.limits[index] && meter.value.includes(expected.units[index]))
        }), outcome.geometry.nativeResellers)
        const capacityContracts = [
          { username: 'fixture-one', unlimited: false, values: ['5', '10240', '102400'], display: ['5', '10,240', '102,400'] },
          { username: 'fixture-two', unlimited: true, values: ['', '', ''], display: [unlimited, unlimited, unlimited] },
        ]
        check('reseller-capacity-detail-identities-preserved', outcome.geometry.resellerDetails.length === capacityContracts.length && capacityContracts.every(expected => outcome.geometry.resellerDetails.filter(detail => detail.username === expected.username).length === 1), outcome.geometry.resellerDetails)
        for (const expected of capacityContracts) {
          const detail = outcome.geometry.resellerDetails.find(item => item.username === expected.username)
          check('reseller-capacity-limits-' + expected.username, detail?.capacities.length === 3 && ['maxAccounts', 'totalDiskMb', 'totalBandwidthMb'].every((name, index) => {
            const capacity = detail.capacities[index]
            return capacity.name === name && capacity.value === expected.values[index] && capacity.unlimited === expected.unlimited && honestUnknown(capacity.meter) && capacity.meter.limit === expected.display[index] && (index === 0 || capacity.label.includes('(MiB)') && capacity.meter.value.includes(' MiB'))
          }), detail)
        }
      }
      else check('mail-known-usage-survives-unknown-cap', outcome.geometry.meters.length > 0 && outcome.geometry.meters.every(meter => meter.used === '7' && meter.limit === (locale === 'ar' ? 'غير متاح' : 'Unavailable')), outcome.geometry.meters)
      check('actual-surface-no-page-errors', outcome.errors.length === 0, outcome.errors)
      outcome.status = outcome.checks.every(check => check.passed) ? 'passed' : 'failed'
    } catch (error) { outcome.status = 'failed'; outcome.error = { name: error.name, message: error.message } }
    outcome.screenshot = 'screenshots/' + id + '.png'; await page.screenshot({ path: join(output, outcome.screenshot), fullPage: true }); surfaceOutcomes.push(outcome)
    writeFileSync(join(output, 'surfaces.partial.json'), JSON.stringify({ surfaceOutcomes }, null, 2) + '\n')
    await context.close()
  }
} finally {
  await browser.close()
  await new Promise((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()) })
}
const after = fingerprint(), drift = before.filter((file, i) => file.sha256 !== after[i].sha256).map(file => file.path)
const report = { status: [...outcomes, ...surfaceOutcomes].every(item => item.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', scope: 'Diagnostic component and actual-surface renderer browser regression only; no live resource, quota, mail or host qualification.', source: { before, after, drift }, views: outcomes.length, statesPerView: cases.length, componentStates: outcomes.length * cases.length, surfaceViews: surfaceOutcomes.length, outcomes, surfaceOutcomes }
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, views: report.views, componentStates: report.componentStates, surfaceViews: report.surfaceViews, drift, failures: [...outcomes, ...surfaceOutcomes].filter(item => item.status !== 'passed').map(item => ({ id: item.id, error: item.error, checks: item.checks.filter(check => !check.passed).map(check => check.name) })) }))
process.exitCode = report.status === 'passed' ? 0 : 1
