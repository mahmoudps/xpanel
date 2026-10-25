import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const output = resolve(argument('--output') ?? 'test-results/technical-values')
if (existsSync(output)) throw new Error('Preserve prior evidence; choose a fresh output directory.')
mkdirSync(join(output, 'screenshots'), { recursive: true })
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const inputs = ['apps/web/src/charts.ts', 'apps/web/src/surfaces/xpanel.ts', 'apps/web/src/board-port/approved-xpanel-workspaces.ts', 'apps/web/src/board-port/approved-xpanel-pages.ts', 'apps/web/src/surfaces/xwhm.ts', 'apps/web/src/plan-editor.ts', 'packages/core/src/rules/plans.ts', 'apps/web/src/tokens.ts', 'apps/web/src/ws-client.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/technical-values-acceptance.mjs']
const fingerprint = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const before = fingerprint()
const pages = [['traffic', '/metrics/traffic'], ['io', '/whm/monitoring/io'], ['plans', '/whm/plans'], ['outbound', '/whm/email/outbound']]
const samples = argument('--samples') === 'red' ? [
  { kind: 'traffic', locale: 'ar', theme: 'dark', width: 360, density: 'compact' },
  { kind: 'io', locale: 'ar', theme: 'dark', width: 360, density: 'compact' },
  { kind: 'plans', locale: 'en', theme: 'light', width: 1440, density: 'compact' },
  { kind: 'plans', locale: 'ar', theme: 'dark', width: 360, density: 'compact' },
  { kind: 'outbound', locale: 'en', theme: 'light', width: 1440, density: 'compact' },
] : pages.flatMap(([kind]) => ['en', 'ar'].flatMap(locale => ['light', 'dark'].flatMap(theme => [360, 768, 1440].flatMap(width => ['default', 'compact'].map(density => ({ kind, locale, theme, width, density }))))))
const fixture = await createVisualFixture(), browser = await chromium.launch({ headless: true }), outcomes = []

// Resolve the browser's actual native input text, including its user-agent shadow
// tree. A mirror element or CSS direction alone cannot prove native glyph order.
async function nativeInputObservation(page, id, expected) {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable'); await session.send('CSS.enable')
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true })
    const find = (node, predicate) => {
      if (predicate(node)) return node
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) { const found = find(child, predicate); if (found) return found }
    }
    const input = find(root, node => { const i = node.attributes?.indexOf('id'); return node.nodeName === 'INPUT' && i >= 0 && node.attributes[i + 1] === id })
    assert.ok(input, 'Expected populated native input must exist: ' + id)
    const text = find(input, node => node.nodeType === 3 && node.nodeValue === expected)
    assert.ok(text, 'Chromium must expose the actual nonempty native input glyph node')
    const { object } = await session.send('DOM.resolveNode', { backendNodeId: text.backendNodeId })
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const raw = this.textContent
        const box = (from, to) => { const range = document.createRange(); range.setStart(this, from); range.setEnd(this, to); const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
        return { raw, characters: [...raw].map((character, index) => ({ character, ...box(index, index + 1) })), whole: box(0, raw.length), direction: getComputedStyle(this.parentElement).direction }
      }.toString(),
    })
    assert.ok(!exceptionDetails, 'Native input glyph geometry must be measurable')
    const textHost = find(input, node => node.children?.some(child => child.nodeId === text.nodeId))
    assert.ok(textHost?.nodeId, 'The actual native glyph container must be observable')
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId: textHost.nodeId })
    return { id, expected, ...result.value, applied_fonts: fonts }
  } finally { await session.detach() }
}

try {
  for (const sample of samples) {
    const path = pages.find(([kind]) => kind === sample.kind)[1], id = [sample.kind, sample.locale, sample.theme, sample.width, sample.density].join('-')
    const outcome = { ...sample, path, id, synthetic: true, status: 'running', checks: [], page_errors: [], console_errors: [], mutations: [] }
    const check = (name, condition, observed) => outcome.checks.push({ name, passed: Boolean(condition), observed })
    const context = await browser.newContext({ viewport: { width: sample.width, height: 900 }, reducedMotion: 'reduce', colorScheme: sample.theme }), page = await context.newPage()
    page.on('pageerror', error => outcome.page_errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') outcome.console_errors.push(message.text()) })
    await context.route('**/*', route => { if (!['GET', 'HEAD'].includes(route.request().method())) { outcome.mutations.push(route.request().method()); return route.abort() } return route.continue() })
    try {
      const response = await page.goto(fixture.baseUrl + path + '?lang=' + sample.locale + '&theme=' + sample.theme + '&density=' + sample.density + '&accountId=visual-account', { waitUntil: 'networkidle' })
      assert.equal(response.status(), 200); await page.evaluate(() => document.fonts.ready)
      outcome.geometry = await page.evaluate(kind => {
        const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
        const glyph = e => { const range = document.createRange(); range.selectNodeContents(e); const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
        const rtl = document.documentElement.dir === 'rtl', edgeDelta = (a, b) => Math.abs(rtl ? a.right - b.right : a.left - b.left)
        const pairs = []
        for (const value of document.querySelectorAll('.xp-kpi__value, .xp-meter__values, #whm-plans [data-plan-row] td')) {
            const raw = value.textContent, match = /(\d+(?:\.\d+)?%?)\s*(?:GiB|MiB|GB|MB|KB|B)?\s*[\/·]\s*(\d+(?:\.\d+)?%?)/.exec(raw)
            if (!match) continue
            const firstAt = match.index, secondAt = firstAt + match[0].lastIndexOf(match[2])
            const range = (from, to) => {
              const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT), r = document.createRange(); let node, offset = 0, started = false
              while (node = walker.nextNode()) {
                const end = offset + node.textContent.length
                if (!started && from < end) { r.setStart(node, from - offset); started = true }
                if (started && to <= end) { r.setEnd(node, to - offset); break }
                offset = end
              }
              const b = r.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
            }
            pairs.push({ raw, first: range(firstAt, firstAt + match[1].length), second: range(secondAt, secondAt + match[2].length), label: value.previousElementSibling?.textContent.trim(), direction: getComputedStyle(value).direction })
        }
        const kpis = [...document.querySelectorAll('.xp-kpi__value')].map(e => ({ text: e.textContent.trim(), value_glyph: glyph(e), label_glyph: glyph(e.previousElementSibling), logical_edge_delta: edgeDelta(glyph(e), glyph(e.previousElementSibling)), direction: getComputedStyle(e).direction, unicode_bidi: getComputedStyle(e).unicodeBidi, font_size: getComputedStyle(e).fontSize, line_height: getComputedStyle(e).lineHeight }))
        const wrappers = [...document.querySelectorAll('#main-content .xp-table-wrap')].map((e, index) => {
          const card = e.closest('.xp-card, .xp-panel-detail__card'), table = e.querySelector('table')
          if (!card || !table) throw new Error('Table region lacks its semantic card/table: ' + index)
          const native = Boolean(e.closest('[data-surface-widget="website-analytics"]'))
          const key = table.dataset.workspaceTable ?? (native ? 'native-top-entries' : 'native-table')
          const columns = table.querySelectorAll('thead th').length
          const rows = [...table.querySelectorAll('tbody tr')].map(row => ({ cells: [...row.children].map(cell => ({ colspan: cell.colSpan, text: cell.textContent.trim(), ...rect(cell) })), column_span: [...row.children].reduce((count, cell) => count + cell.colSpan, 0) }))
          return { index, key, native, columns, rows, ...rect(e), table: rect(table), client_width: e.clientWidth, scroll_width: e.scrollWidth, overflow_x: getComputedStyle(e).overflowX, role: e.getAttribute('role'), tabindex: e.tabIndex, card: rect(card) }
        })
        const tokenObservation = (e, source, tableKey, column) => {
          const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let node, longest
          while (node = walker.nextNode()) if (!longest || node.textContent.length > longest.textContent.length) longest = node
          if (!longest) return { source, tableKey, column, raw: '', characters: [] }
          const raw = longest.textContent, characters = []
          for (let i = 0; i < raw.length; i++) {
            if (/\s/.test(raw[i])) continue
            const range = document.createRange(); range.setStart(longest, i); range.setEnd(longest, i + 1)
            const r = range.getBoundingClientRect(); characters.push({ character: raw[i], left: r.left, right: r.right, top: r.top, bottom: r.bottom })
          }
          return { source, tableKey, column, raw, characters }
        }
        const technical_tokens = []
        if (kind === 'traffic') for (const table of document.querySelectorAll('#main-content .xp-table-wrap table')) {
          const native = Boolean(table.closest('[data-surface-widget="website-analytics"]'))
          const key = table.dataset.workspaceTable ?? 'native-top-entries'
          const columns = native ? [0, 2] : key === 'top-pages' ? [0, 1, 2] : key === 'error-paths' ? [0, 1] : null
          if (!columns) throw new Error('Unclassified traffic table: ' + key)
          for (const row of table.querySelectorAll('tbody tr')) {
            // A full-width read-status cell is measured as status, never as a path or byte value.
            if (row.children.length === 1 && row.children[0].colSpan === table.querySelectorAll('thead th').length) continue
            for (const column of columns) {
              const cell = row.children[column]
              if (!cell) throw new Error('Missing technical traffic cell: ' + key + ':' + column)
              technical_tokens.push(tokenObservation(cell, native ? 'native' : 'approved', key, column))
            }
          }
        }
        if (kind === 'io') for (const e of document.querySelectorAll('.xp-io-monitor .xp-table tbody td:first-child .xp-mono, .xp-io-monitor .xp-table tbody td:nth-child(2) .xp-mono, .xp-io-monitor .xp-table tbody td:nth-child(3)')) technical_tokens.push(tokenObservation(e, 'native', 'io', null))
        const approved_fields = [...document.querySelectorAll('[data-approved-xpanel-workspace] .xp-field, [data-approved-xpanel-workspace] .xp-panel-detail__facts > div')].map(e => {
          const label = e.querySelector(':scope > label, :scope > dt'), value = e.querySelector(':scope > input, :scope > select, :scope > textarea, :scope > dd')
          if (!label || !value) throw new Error('Approved field lacks its label/value pair')
          const control = ['INPUT', 'SELECT', 'TEXTAREA'].includes(value.tagName)
          const component = e.closest('[data-workspace-section]')?.dataset.workspaceSection, index = [...e.parentElement.children].indexOf(e)
          if (!component || index < 0) throw new Error('Approved field lacks its component identity')
          return { identity: component + ':' + index, component, index, label: label.textContent.trim(), id: value.id, tag: value.tagName, text: control ? value.value : value.textContent.trim(), gap: rect(value).top - rect(label).bottom, logical_edge_delta: edgeDelta(rect(value), rect(label)), glyph_edge_delta: control ? null : edgeDelta(glyph(value), glyph(label)), label_glyph: glyph(label), control: rect(value) }
        })
        const fields = ['mail-outbound-mode', 'mail-default-ipv4', 'mail-default-ipv6', 'mail-default-helo'].map(id => { const c = document.getElementById(id), l = document.querySelector('label[for="' + id + '"]'); return c && l ? { id, gap: rect(c).top - rect(l).bottom, logical_edge_delta: edgeDelta(rect(c), rect(l)), control: rect(c) } : null }).filter(Boolean)
        const label = document.querySelector('#whm-plans label[for="plan-addonDomains-unlimited"]')
        const planInputs = ['plan-ioReadBps', 'plan-ioWriteBps'].map(id => {
          const input = document.getElementById(id), inputLabel = document.querySelector('label[for="' + id + '"]')
          return input && inputLabel ? { id, name: input.name, type: input.type, value: input.value, disabled: input.disabled, associated: input.labels.length === 1 && input.labels[0] === inputLabel, dir: input.dir, computed_direction: getComputedStyle(input).direction, ...rect(input), label_glyph: glyph(inputLabel), logical_edge_delta: edgeDelta(rect(input), rect(inputLabel)) } : null
        }).filter(Boolean)
        const planEditor = document.querySelector('[data-native-plan-editor]'), feature = planEditor?.querySelector('[name="featureListId"]')
        const planEditorState = planEditor ? { editable: planEditor.dataset.planEditable, savedId: planEditor.getAttribute('data-plan-id'), saveDisabled: planEditor.querySelector('[data-native-plan-save]').disabled, featureId: feature.value, featureOptions: [...feature.options].map(option => ({ value: option.value, text: option.text })) } : null
        const io = document.querySelector('.xp-io-monitor'), ioHeader = io?.querySelector(':scope > .xp-card__header'), ioStatus = io?.querySelector(':scope > [data-resource-observation-state]'), nestedHeader = io?.querySelector(':scope > .xp-card > .xp-card__header')
        const ioContract = kind === 'io' ? { incomplete: ioStatus?.dataset.resourceObservationState, legacyLive: document.querySelectorAll('.xp-io-monitor [data-live-kpi]').length, supplied: document.querySelectorAll('[data-resource-observation]').length, hostRatio: /RAM\s+\d+\s*\/|Load\s+\d/.test(io.textContent), headerStatusGap: rect(ioStatus).top - rect(ioHeader).bottom, nestedHeaderMargin: parseFloat(getComputedStyle(nestedHeader).marginBlockEnd) } : null
        return { viewport: innerWidth, document_scroll_width: document.documentElement.scrollWidth, body_overflow_x: getComputedStyle(document.body).overflowX, root_overflow_x: getComputedStyle(document.documentElement).overflowX, pairs, kpis, wrappers, fields, approved_fields, technical_tokens, ioContract, unlimited_label: label ? rect(label) : null, plan_inputs: planInputs, plan_editor: planEditorState }
      }, sample.kind)
      const g = outcome.geometry
      check('document-fits-viewport', g.document_scroll_width <= sample.width + 1, g.document_scroll_width)
      check('no-root-overflow-concealment', !['hidden', 'clip'].includes(g.body_overflow_x) && !['hidden', 'clip'].includes(g.root_overflow_x), [g.body_overflow_x, g.root_overflow_x])
      if (sample.kind === 'traffic' || sample.kind === 'io') {
        check('all-metric-values-share-label-edge', g.kpis.length === 6 && g.kpis.every(value => value.logical_edge_delta <= 1), g.kpis.map(value => value.logical_edge_delta))
        check('whole-technical-table-phrase-glyph-order', g.technical_tokens.filter(token => token.source === 'native').length === (sample.kind === 'traffic' ? 6 : 3) && g.technical_tokens.every(token => token.characters.length >= (token.source === 'native' ? 2 : 1) && token.characters.every((character, i, all) => i === 0 || (Math.abs(character.top - all[0].top) <= 1 && character.left >= all[i - 1].left - 0.5))), g.technical_tokens)
        check('compound-metric-glyph-order', g.pairs.length >= 1 && g.pairs.every(pair => pair.first.left < pair.second.left), g.pairs)
        check('technical-values-retain-direction-after-text-replacement', g.kpis.every(value => value.direction === 'ltr' && ['isolate', 'isolate-override'].includes(value.unicode_bidi)), g.kpis.map(value => [value.direction, value.unicode_bidi]))
        if (sample.kind === 'io') {
          check('unqualified-IO-excludes-legacy-live-and-host-ratios', g.ioContract.incomplete === 'incomplete' && g.ioContract.legacyLive === 0 && g.ioContract.supplied === 3 && !g.ioContract.hostRatio, g.ioContract)
          check('IO-header-status-gap-24px-with-nested-header-preserved', Math.abs(g.ioContract.headerStatusGap - 24) <= 0.5 && Math.abs(g.ioContract.nestedHeaderMargin - 16) <= 0.5, g.ioContract)
        }
        outcome.live_text_replacement = await page.evaluate(kind => {
          const e = document.querySelector(kind === 'io' ? '[data-resource-observation]' : '[data-live-kpi]'), original = e.innerHTML
          // Exercise actual textContent replacement geometry. The unqualified IO
          // wrapper is excluded from the legacy live client until producer cutover.
          e.textContent = '12.50 MB/s'
          const node = e.firstChild, ranges = []
          for (const [from, to] of [[0, 5], [6, 10]]) { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); const b = r.getBoundingClientRect(); ranges.push({ left: b.left, right: b.right }) }
          const result = { raw: e.textContent, direction: getComputedStyle(e).direction, number: ranges[0], unit: ranges[1] }; e.innerHTML = original; return result
        }, sample.kind)
        check('text-replacement-number-before-unit', outcome.live_text_replacement.number.left < outcome.live_text_replacement.unit.left, outcome.live_text_replacement)
      }
      if (sample.kind === 'traffic') {
        check('all-three-top-entry-tables-preserved', g.wrappers.filter(w => w.native).length === 3, g.wrappers)
        check('all-approved-traffic-tables-preserved', g.wrappers.length === 5 && ['top-pages', 'error-paths'].every(key => g.wrappers.filter(w => w.key === key && !w.native).length === 1), g.wrappers)
        check('all-traffic-table-rows-match-header-spans', g.wrappers.every(w => w.columns > 0 && w.rows.length > 0 && w.rows.every(row => row.column_span === w.columns && row.cells.every(cell => cell.text.length > 0))), g.wrappers)
        check('approved-traffic-technical-cells-covered', g.technical_tokens.filter(token => token.source === 'approved').length === 3 && g.technical_tokens.filter(token => token.source === 'approved').every(token => token.tableKey === 'top-pages'), g.technical_tokens)
        check('table-scroll-regions-contained', g.wrappers.every(w => w.left >= -1 && w.right <= sample.width + 1 && w.left >= w.card.left - 1 && w.right <= w.card.right + 1 && w.overflow_x === 'auto' && w.role === 'region' && w.tabindex === 0), g.wrappers)
        const expectedApprovedFields = [
          ['metrics-scope:0', 'SELECT', ['Domain', 'النطاق']], ['metrics-scope:1', 'SELECT', ['Range', 'الفترة']],
          ['visitors:0', 'INPUT', ['Unique visitors', 'الزوار الفريدون']], ['visitors:1', 'INPUT', ['Requests', 'الطلبات']],
          ['response-status:0', 'INPUT', ['2xx', '2xx']], ['response-status:1', 'INPUT', ['3xx', '3xx']],
          ['response-status:2', 'INPUT', ['4xx', '4xx']], ['response-status:3', 'INPUT', ['5xx', '5xx']],
          ['account-context:0', 'DD', ['Account', 'الحساب']], ['account-context:1', 'DD', ['Domain', 'النطاق']], ['account-context:2', 'DD', ['Plan', 'الخطة']],
          ['bandwidth:0', 'DD', ['Domain', 'النطاق']], ['bandwidth:1', 'DD', ['Transferred', 'البيانات المنقولة']],
        ]
        check('approved-traffic-field-identities-preserved', g.approved_fields.length === expectedApprovedFields.length && new Set(g.approved_fields.map(field => field.identity)).size === expectedApprovedFields.length && expectedApprovedFields.every(([identity, tag, labels]) => g.approved_fields.some(field => field.identity === identity && field.tag === tag && field.label === labels[sample.locale === 'ar' ? 1 : 0])), g.approved_fields)
        const fieldComponents = {
          main: g.approved_fields.filter(field => ['metrics-scope', 'visitors', 'response-status'].includes(field.component)).length,
          identity: g.approved_fields.filter(field => field.component === 'account-context').length,
          bandwidth: g.approved_fields.filter(field => field.component === 'bandwidth').length,
        }
        check('approved-traffic-field-component-counts', fieldComponents.main === 8 && fieldComponents.identity === 3 && fieldComponents.bandwidth === 2, fieldComponents)
        check('approved-traffic-field-label-gaps-and-edges', g.approved_fields.length === expectedApprovedFields.length && g.approved_fields.every(field => Math.abs(field.gap - 8) <= 0.5 && field.logical_edge_delta <= 1 && (field.glyph_edge_delta === null || field.glyph_edge_delta <= 1)), g.approved_fields)
        outcome.approved_native_inputs = []
        for (const field of g.approved_fields.filter(field => field.tag === 'INPUT' && field.text.length > 0)) outcome.approved_native_inputs.push({ ...await nativeInputObservation(page, field.id, field.text), label_glyph: field.label_glyph })
        check('approved-traffic-input-glyph-order-and-label-edge', outcome.approved_native_inputs.length === 6 && outcome.approved_native_inputs.every(input => input.raw === input.expected && input.characters.length > 0 && input.characters.every((character, i, all) => i === 0 || (Math.abs(character.top - all[0].top) <= 1 && character.left >= all[i - 1].left - 0.5)) && Math.abs(sample.locale === 'ar' ? input.whole.right - input.label_glyph.right : input.whole.left - input.label_glyph.left) <= 1), outcome.approved_native_inputs)
      }
      if (sample.kind === 'traffic' && sample.width === 360) {
        check('narrow-tables-scroll-instead-of-clipping', g.wrappers.filter(w => w.native).every(w => w.scroll_width > w.client_width + 1), g.wrappers)
        check('additional-tables-fit-or-provide-real-overflow', g.wrappers.every(w => w.table.width <= w.client_width + 1 || w.scroll_width > w.client_width + 1), g.wrappers)
        outcome.table_scroll_observations = []; outcome.table_scroll_restorations = []
        // Every table is focused and audited. Fitting additions need no fictitious scroll;
        // all overflowing tables, including additions, must scroll by actual keyboard input.
        for (const wrapper of g.wrappers) {
          const scrollRegion = page.locator('#main-content .xp-table-wrap').nth(wrapper.index)
          await scrollRegion.focus()
          const scrollBefore = await scrollRegion.evaluate(e => e.scrollLeft)
          const overflow = wrapper.scroll_width > wrapper.client_width + 1
          if (overflow) {
            await page.keyboard.press(sample.locale === 'ar' ? 'ArrowLeft' : 'ArrowRight')
            await page.waitForFunction(before => Math.abs(document.activeElement.scrollLeft - before) > 1, scrollBefore, { timeout: 2000 }).catch(() => {})
          }
          const observation = await scrollRegion.evaluate((e, before) => ({ focused: document.activeElement === e, before, after: e.scrollLeft, document_scroll_x: scrollX }), scrollBefore)
          outcome.table_scroll_observations.push({ index: wrapper.index, key: wrapper.key, overflow, ...observation })
          const restoration = await scrollRegion.evaluate(async (e, before) => {
            let last = e.scrollLeft, stable = 0
            for (let frame = 0; frame < 40 && stable < 4; frame++) {
              await new Promise(resolve => requestAnimationFrame(resolve))
              stable = Math.abs(e.scrollLeft - last) < 0.1 ? stable + 1 : 0; last = e.scrollLeft
            }
            e.scrollLeft = before; e.blur()
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            return { before, restored: e.scrollLeft, settled_frames: stable }
          }, scrollBefore)
          outcome.table_scroll_restorations.push({ index: wrapper.index, ...restoration })
        }
        outcome.scroll_observation = outcome.table_scroll_observations[0]
        outcome.scroll_restoration = outcome.table_scroll_restorations[0]
        check('real-keyboard-horizontal-scroll', outcome.table_scroll_observations.length === g.wrappers.length && outcome.table_scroll_observations.every(observation => observation.focused && (!observation.overflow || Math.abs(observation.after - observation.before) > 1) && observation.document_scroll_x === 0), outcome.table_scroll_observations)
        check('keyboard-scroll-restored-before-review-image', outcome.table_scroll_restorations.length === g.wrappers.length && outcome.table_scroll_restorations.every(restoration => restoration.settled_frames >= 4 && Math.abs(restoration.restored - restoration.before) < 0.5), outcome.table_scroll_restorations)
      }
      if (sample.kind === 'outbound') {
        check('all-four-label-gaps-are-8px', g.fields.length === 4 && g.fields.every(field => Math.abs(field.gap - 8) <= 0.5), g.fields)
        check('outbound-label-control-edges-and-targets', g.fields.every(field => field.logical_edge_delta <= 1 && field.control.height >= 43.5), g.fields)
      }
      if (sample.kind === 'plans') {
        const expected = [{ id: 'plan-ioReadBps', name: 'ioReadBps', value: '50' }, { id: 'plan-ioWriteBps', name: 'ioWriteBps', value: '25' }]
        check('current-plan-IO-controls-preserve-separate-MiB-values', g.plan_inputs.length === 2 && expected.every((field, index) => g.plan_inputs[index].id === field.id && g.plan_inputs[index].name === field.name && g.plan_inputs[index].type === 'number' && g.plan_inputs[index].value === field.value && !g.plan_inputs[index].disabled && g.plan_inputs[index].associated), g.plan_inputs)
        check('plan-editor-uses-actual-feature-list-read', g.plan_editor?.editable === 'true' && g.plan_editor.savedId === null && g.plan_editor.saveDisabled && g.plan_editor.featureId === 'visual-features' && g.plan_editor.featureOptions.length === 1 && g.plan_editor.featureOptions[0].text === 'Synthetic visual features', g.plan_editor)
        outcome.native_inputs = []
        for (const field of expected) outcome.native_inputs.push(await nativeInputObservation(page, field.id, field.value))
        check('native-plan-input-glyph-order', outcome.native_inputs.length === 2 && outcome.native_inputs.every(input => input.raw === input.expected && input.characters.length >= 2 && input.direction === 'ltr' && input.characters.every((character, index, all) => character.right > character.left && (index === 0 || (Math.abs(character.top - all[0].top) <= 1 && character.left > all[index - 1].left)))), outcome.native_inputs)
        check('plan-input-direction-and-label-edge', g.plan_inputs.length === 2 && g.plan_inputs.every(input => input.dir === 'ltr' && input.computed_direction === 'ltr' && input.logical_edge_delta <= 1 && input.height >= 43.5), g.plan_inputs)
        check('compound-plan-row-glyph-order', g.pairs.length >= 2 && g.pairs.every(pair => pair.first.left < pair.second.left), g.pairs)
        check('unlimited-clickable-label-44px', g.unlimited_label.height >= 43.5, g.unlimited_label)
        const label = page.locator('#whm-plans label[for="plan-addonDomains-unlimited"]'), checkbox = label.locator('input[name="unlimited.addonDomains"]')
        const initial = await checkbox.isChecked(); await label.click({ position: { x: 8, y: 8 } }); const toggled = await checkbox.isChecked(); await checkbox.setChecked(initial)
        check('label-padding-is-actual-click-target', initial !== toggled, { initial, toggled, restored: await checkbox.isChecked() })
        check('restoring-unlimited-retains-clean-disabled-save', await page.locator('[data-native-plan-save]').isDisabled(), await page.locator('[data-native-plan-save]').isDisabled())
      }
      outcome.heading_font = await assertAppliedFont(page, '#main-content h1', sample.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
      check('no-page-console-errors-or-writes', outcome.page_errors.length === 0 && outcome.console_errors.length === 0 && outcome.mutations.length === 0, { page_errors: outcome.page_errors, console_errors: outcome.console_errors, mutations: outcome.mutations })
      outcome.status = outcome.checks.every(c => c.passed) ? 'passed' : 'failed'
    } catch (error) { outcome.status = 'failed'; outcome.error = { name: error.name, message: error.message, applied_font: error.appliedFontObservation } }
    // Interaction checks may scroll a long page; retain final review images at
    // the document start rather than placing sticky chrome over a lower card.
    await page.evaluate(() => { scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    outcome.screenshot_scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
    outcome.screenshot = 'screenshots/' + id + '.png'; await page.screenshot({ path: join(output, outcome.screenshot), fullPage: true }); outcomes.push(outcome)
    writeFileSync(join(output, 'results.partial.json'), JSON.stringify({ outcomes }, null, 2) + '\n'); await context.close()
  }
} finally { await browser.close(); await fixture.close() }
const after = fingerprint(), drift = before.filter((file, i) => file.sha256 !== after[i].sha256).map(file => file.path)
const report = { status: outcomes.every(o => o.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', scope: 'Synthetic visual/browser regression only; no live hosting or WebSocket qualification.', source: { before, after, drift }, outcomes }
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, states: outcomes.length, passed: outcomes.filter(o => o.status === 'passed').length, drift, failures: outcomes.filter(o => o.status !== 'passed').map(o => ({ id: o.id, error: o.error?.message, checks: o.checks.filter(c => !c.passed).map(c => c.name) })) }))
process.exitCode = report.status === 'passed' ? 0 : 1
