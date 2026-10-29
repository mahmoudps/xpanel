import { requireBrowserDiskHeadroom } from './resource-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp } from '../../apps/web/src/app.ts'
import { BROWSER_REALTIME_SCRIPT } from '../../apps/web/src/ws-client.ts'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const planId = '10000000-0000-4000-8000-000000000001'
const secondPlanId = '10000000-0000-4000-8000-000000000002'
const createdPlanId = '10000000-0000-4000-8000-000000000003'
const featureId = '20000000-0000-4000-8000-000000000001'
const otherFeatureId = '20000000-0000-4000-8000-000000000002'
const resellerId = '30000000-0000-4000-8000-000000000001'
const neighborId = '30000000-0000-4000-8000-000000000002'
const principal = { kind: 'root', id: 'synthetic-root', username: 'synthetic-root' }
const reseller = { id: resellerId, username: 'scopedreseller', acl: ['list-accounts', 'edit-account', 'suspend-account', 'change-password', 'terminate-account', 'create-account', 'manage-plans'], maxAccounts: 40, totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: true, nameservers: [], delegatedIps: [] }
const plan = defaultPlan({ id: planId, name: 'Standard', ownerId: null, featureListId: featureId })
plan.resources.ioReadBps = 2 * 1048576
plan.resources.ioWriteBps = 1048576
const secondPlan = { ...plan, id: secondPlanId, name: 'Alternate', featureListId: otherFeatureId }
const account = (index, overrides = {}) => ({ id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, username: 'acct' + String(index).padStart(2, '0'), uid: 20000 + index, gid: 20000 + index, home: '/home/synthetic' + index, primaryDomain: 'acct' + index + '.example.test', planId: index % 2 ? secondPlanId : planId, ownerId: null, status: index === 22 ? 'suspended' : 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-24T00:00:00Z', ...overrides })
const accounts = [...Array.from({ length: 23 }, (_, index) => account(index)), account(23, { username: 'resellalpha', ownerId: resellerId }), account(24, { username: 'resellbeta', ownerId: resellerId, status: 'suspended' }), account(25, { username: 'private-neighbor', ownerId: neighborId })]
const baseMail = { mode: 'custom-map', defaultIpv4: '192.0.2.1', defaultIpv6: null, defaultHelo: 'mail.example.test', domainOverrides: [{ domainName: 'alpha.example.test', ipv4: '192.0.2.11', ipv6: null, heloHostname: 'alpha-mail.example.test' }] }
const freshMail = { ...baseMail, defaultIpv6: '2001:db8::99', defaultHelo: 'fresh-mail.example.test', domainOverrides: [...baseMail.domainOverrides, { domainName: 'fresh.example.test', ipv4: '192.0.2.12', ipv6: '2001:db8::12', heloHostname: 'fresh.example.test' }] }
// Qualification and identities below exist only inside this loopback UI fixture.
// The runner never authenticates a production session or executes host/mail work.
const catalog = tools.map(tool => ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic native workflow presentation only.', evidence: [] } }))
const states = ['en', 'ar'].flatMap(locale => [360, 1440].map(width => ({ locale, width, theme: width === 360 ? 'dark' : 'light' })))

function fingerprint() {
  const files = [...new Set([...collectSnapshotFiles(root), 'tests/browser/native-workflows-acceptance.mjs', 'tests/browser/resource-guard.mjs', 'tests/browser/applied-font-contract.mjs'])].sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  return { sha256: computeSourceDigest(files), files }
}

async function fixture() {
  const requests = [], held = new Set()
  let planMode = 'success', mailMode = 'success', nextPlanHold
  const server = createServer(async (incoming, outgoing) => {
    try {
    const url = new URL(incoming.url, 'http://127.0.0.1')
    const respond = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(body)) }
    if (url.pathname === '/api/auth/me') { respond(200, { csrfToken: 'synthetic-native-csrf' }); return }
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const chunk of incoming) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ method: incoming.method, path: url.pathname, body, csrf: incoming.headers['x-csrf-token'], contentType: incoming.headers['content-type'] })
      if (url.pathname === '/api/plans' || url.pathname.startsWith('/api/plans/')) {
        const hold = nextPlanHold; nextPlanHold = undefined
        if (hold) await hold
        if (planMode === 'refused') { respond(422, { code: 'VALIDATION_ERROR', detail: 'untrusted-synthetic-detail', details: { stateChanged: false } }); return }
        if (planMode === 'uncertain') { respond(503, { code: 'INTERNAL_ERROR', detail: 'untrusted-synthetic-detail', details: { stateChanged: true, verificationRequired: true } }); return }
        const id = incoming.method === 'POST' ? createdPlanId : url.pathname.split('/').at(-1)
        respond(incoming.method === 'POST' ? 201 : 200, { plan: { ...body, id, ownerId: Object.hasOwn(body, 'ownerId') ? body.ownerId : null }, reconcile: { status: 'applied' } }); return
      }
      if (url.pathname === '/api/mail/ips' && incoming.method === 'GET') {
        if (mailMode === 'get-failed') { respond(503, { code: 'SERVICE_UNAVAILABLE' }); return }
        respond(200, { config: freshMail }); return
      }
      if (url.pathname === '/api/mail/ips' && incoming.method === 'PUT') {
        respond(200, mailMode === 'uncertain' ? { config: { ...body, domainOverrides: [] } } : { config: body }); return
      }
      if (/^\/api\/accounts\/[^/]+\/(?:suspend|unsuspend)$/.test(url.pathname)) { respond(403, { code: 'FORBIDDEN', details: { stateChanged: false } }); return }
      respond(404, { code: 'NOT_FOUND' }); return
    }
    if (!['/whm/plans', '/whm/accounts', '/whm/email/outbound'].includes(url.pathname)) { outgoing.writeHead(404); outgoing.end(); return }
    const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en', theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
    const asReseller = url.searchParams.get('actor') === 'reseller'
    const actor = asReseller ? { kind: 'reseller', id: resellerId, username: reseller.username } : principal
    const requested = url.searchParams.get('planId')
    const editor = requested ? requested === planId ? { kind: 'edit', plan } : { kind: 'unavailable' } : { kind: 'create' }
    const html = renderWebApp({ surface: 'xwhm', activeRoute: url.pathname, locale, theme, catalog,
      visibility: { principal: actor, ...(asReseller ? { reseller } : {}), disabledFeatures: new Set() }, security: { totpEnabled: true }, realtimeEnabled: false,
      whm: { principal: actor, ...(asReseller ? { activeReseller: reseller } : {}), plans: [plan, secondPlan], accounts, resellers: [reseller, { ...reseller, id: neighborId, username: 'neighborreseller' }], featureLists: [{ id: featureId, name: 'Standard features' }, { id: otherFeatureId, name: 'Alternate features' }], planEditorState: editor, mailIpConfig: baseMail, ipPool: [] },
    })
    assert.ok(html.includes(BROWSER_REALTIME_SCRIPT), 'The actual current render must include the actual runtime client')
    outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); outgoing.end(html.replace('<html ', '<html data-native-workflow-fixture="synthetic-qualified-presentation" '))
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end('{"code":"SYNTHETIC_RENDER_FAILED"}')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests,
    setPlanMode(mode) { planMode = mode }, setMailMode(mode) { mailMode = mode },
    holdNextPlan() { let release; nextPlanHold = new Promise(resolve => { release = resolve }); held.add(release); return () => { held.delete(release); release() } },
    async close() { for (const release of held) release(); await new Promise(resolve => { server.closeIdleConnections(); server.close(resolve) }) },
  }
}

async function geometry(page, selector) {
  return page.evaluate(selector => {
    const scope = document.querySelector(selector), rtl = document.documentElement.dir === 'rtl'
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const edge = rectangle => rtl ? rectangle.right : rectangle.left
    const fields = [...scope.querySelectorAll('.xp-field')].filter(field => field.checkVisibility()).flatMap(field => {
      const label = field.querySelector(':scope > label,:scope > dt'), value = field.querySelector(':scope > input:not([type=checkbox]),:scope > select,:scope > textarea,:scope > dd')
      if (!label || !value || !value.checkVisibility()) return []
      const l = rect(label), v = rect(value), range = document.createRange(); range.selectNodeContents(value)
      return [{ name: value.name || label.textContent, gap: v.top - l.bottom, edge: Math.abs(edge(l) - edge(v)), textAlign: getComputedStyle(value).textAlign, direction: getComputedStyle(value).direction, glyphEdge: value.tagName === 'DD' ? Math.abs(edge(l) - edge(range.getBoundingClientRect())) : null }]
    })
    const targets = [...scope.querySelectorAll('button,input,select,textarea,a,summary')].filter(element => element.checkVisibility()).map(element => {
      const target = element.matches('input[type=checkbox]') ? element.labels?.[0] || element : element
      return { tag: element.tagName, type: element.type, ...rect(target) }
    })
    const groups = [...scope.querySelectorAll('.xp-form-group')].filter(element => element.checkVisibility()).map(element => ({ gap: getComputedStyle(element).rowGap, fields: [...element.children].filter(child => child.matches('.xp-field')).map(rect), cards: [...element.children].filter(child => child.matches('.xp-card')).map(rect) }))
    const cards = [...scope.querySelectorAll('.xp-card'), ...(scope.matches('.xp-card') ? [scope] : [])].filter(card => card.checkVisibility()).map(card => ({ padding: getComputedStyle(card).paddingInlineStart, ...rect(card) }))
    const layout = scope.querySelector('[data-account-list-layout]')
    const readonlyValues = [...scope.querySelectorAll('[data-mail-ip-overrides]')].map(value => {
      const container = value.closest('pre'), label = container.previousElementSibling
      const labelRange = document.createRange(), valueRange = document.createRange()
      labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
      const box = value => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height })
      const computed = element => {
        const style = getComputedStyle(element)
        return {
          direction: style.direction, textAlign: style.textAlign, whiteSpace: style.whiteSpace, display: style.display,
          minWidth: style.minWidth, maxWidth: style.maxWidth, width: style.width, inlineSize: style.inlineSize,
          overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, unicodeBidi: style.unicodeBidi,
          overflowX: style.overflowX, overflowY: style.overflowY, textOverflow: style.textOverflow, clipPath: style.clipPath,
          paddingInlineStart: style.paddingInlineStart, paddingInlineEnd: style.paddingInlineEnd,
          borderInlineStartWidth: style.borderInlineStartWidth, borderInlineEndWidth: style.borderInlineEndWidth,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rect: rect(element),
        }
      }
      const fieldBounds = rect(container)
      const overhang = bounds => ({ left: Math.max(0, fieldBounds.left - bounds.left), right: Math.max(0, bounds.right - fieldBounds.right), top: Math.max(0, fieldBounds.top - bounds.top), bottom: Math.max(0, bounds.bottom - fieldBounds.bottom) })
      const outside = bounds => Object.values(overhang(bounds)).some(amount => amount > 1)
      const tokenBoxes = [], characterOverhangs = [], walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT)
      let textNode, tokenCount = 0
      while ((textNode = walker.nextNode())) {
        for (const match of textNode.textContent.matchAll(/\S+/gu)) {
          const token = document.createRange()
          token.setStart(textNode, match.index); token.setEnd(textNode, match.index + match[0].length)
          tokenBoxes.push(...[...token.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(box)); tokenCount++
        }
        const characters = [...textNode.textContent.matchAll(/[\s\S]/gu)].map(match => {
          const character = document.createRange()
          character.setStart(textNode, match.index); character.setEnd(textNode, match.index + match[0].length)
          return { text: match[0], start: match.index, end: match.index + match[0].length, boxes: [...character.getClientRects()].filter(rect => rect.height > 0).map(box) }
        })
        characters.forEach((character, index) => {
          const escaped = character.boxes.filter(outside)
          if (!escaped.length) return
          const before = characters.slice(0, index).reverse().find(item => /\S/u.test(item.text))
          const after = characters.slice(index + 1).find(item => /\S/u.test(item.text))
          const softWrap = Boolean(before && after && before.boxes.length && after.boxes.length
            && !/[\r\n]/u.test(textNode.textContent.slice(before.end, after.start))
            && Math.abs(before.boxes.at(-1).top - after.boxes[0].top) > 1)
          characterOverhangs.push({ codePoint: character.text.codePointAt(0), sourceIndex: character.start, asciiSpace: character.text === ' ', softWrap, rects: escaped, overhangs: escaped.map(overhang) })
        })
      }
      const nonWhitespaceLines = []
      for (const token of tokenBoxes) {
        const line = nonWhitespaceLines.find(line => Math.abs(line.top - token.top) < 0.6)
        if (!line) nonWhitespaceLines.push({ ...token })
        else { line.left = Math.min(line.left, token.left); line.right = Math.max(line.right, token.right); line.top = Math.min(line.top, token.top); line.bottom = Math.max(line.bottom, token.bottom) }
      }
      const labelGlyphEdge = edge(labelRange.getBoundingClientRect())
      const inkEdge = tokenBoxes.length ? (rtl ? Math.max(...tokenBoxes.map(rect => rect.right)) : Math.min(...tokenBoxes.map(rect => rect.left))) : null
      const fullRangeOverhang = overhang(valueRange.getBoundingClientRect())
      const hasFullOverhang = Object.values(fullRangeOverhang).some(amount => amount > 1)
      const whitespaceOnlyOverhang = !hasFullOverhang || (characterOverhangs.length > 0
        && characterOverhangs.every(item => item.asciiSpace && item.softWrap)
        && Object.keys(fullRangeOverhang).every(side => fullRangeOverhang[side] <= Math.max(0, ...characterOverhangs.flatMap(item => item.overhangs.map(bounds => bounds[side]))) + 1))
      return {
        gap: rect(container).top - rect(label).bottom, glyphEdge: Math.abs(edge(labelRange.getBoundingClientRect()) - edge(valueRange.getBoundingClientRect())),
        rtl, label: computed(label), pre: computed(container), bdi: computed(value), parent: computed(container.parentElement),
        labelRange: { rect: box(labelRange.getBoundingClientRect()), lines: [...labelRange.getClientRects()].map(box) },
        valueRange: { rect: box(valueRange.getBoundingClientRect()), lines: [...valueRange.getClientRects()].map(box) },
        nonWhitespaceRange: {
          tokenCount, inkEdge, labelDelta: inkEdge === null ? null : Math.abs(labelGlyphEdge - inkEdge),
          tokenRects: tokenBoxes, allTokensInside: tokenBoxes.length > 0 && tokenBoxes.every(bounds => !outside(bounds)),
          lines: nonWhitespaceLines.sort((left, right) => left.top - right.top).map(line => ({ rect: { ...line, width: line.right - line.left, height: line.bottom - line.top }, inkEdge: edge(line), labelDelta: Math.abs(labelGlyphEdge - edge(line)) })),
        },
        preservedWhitespace: { fullRangeOverhang, hasFullOverhang, explainedByAsciiSoftWrapSpaces: whitespaceOnlyOverhang, characterOverhangs },
      }
    })
    return { fields, targets, groups, cards, readonlyValues, group24: layout ? getComputedStyle(layout).rowGap : null, overflow: document.documentElement.scrollWidth - innerWidth, ascii: !/[\u0660-\u0669\u06f0-\u06f9]/.test(scope.innerText), page: rect(scope) }
  }, selector)
}

async function verifyPresentation(page, state, selector, result, axeSource) {
  await page.evaluate(() => document.fonts.ready)
  result.geometry = await geometry(page, selector)
  const g = result.geometry
  assert.ok(g.overflow <= 0, 'No document overflow')
  assert.equal(g.ascii, true)
  for (const field of g.fields) {
    assert.ok(Math.abs(field.gap - 8) < 0.6, 'Actual label/value gap must be 8px: ' + field.name)
    assert.ok(field.edge < 0.6, 'Actual label/value box edges must match: ' + field.name)
    if (field.glyphEdge !== null) assert.ok(field.glyphEdge < 1, 'Actual readonly glyph edge must match its label')
  }
  for (const target of g.targets) assert.ok(target.width >= 43.9 && target.height >= 43.9, 'All visible control targets, including checkbox labels, must be 44px')
  for (const value of g.readonlyValues) {
    assert.ok(Math.abs(value.gap - 8) < 0.6, 'Readonly override label/value gap stays 8px')
    // Full-range bounds include preserved wrap spaces; visible text is measured on every actual line.
    assert.ok(value.nonWhitespaceRange.lines.length > 0 && value.nonWhitespaceRange.lines.every(line => line.labelDelta < 1), 'Every actual non-whitespace readonly line, including the first, stays at its label edge within 1px')
    assert.equal(value.nonWhitespaceRange.allTokensInside, true, 'All visible technical token rectangles stay inside their field')
    assert.equal(value.preservedWhitespace.explainedByAsciiSoftWrapSpaces, true, 'Any full-range overhang comes only from preserved ASCII spaces at a soft wrap')
    for (const element of [value.parent, value.pre, value.bdi]) {
      assert.ok(!['hidden', 'clip'].includes(element.overflowX) && !['hidden', 'clip'].includes(element.overflowY), 'Readonly values are not hidden or clipped')
      assert.equal(element.clipPath, 'none')
      assert.notEqual(element.textOverflow, 'ellipsis')
    }
  }
  for (const card of g.cards) assert.equal(card.padding, state.width <= 800 ? '16px' : '24px')
  for (const group of g.groups) {
    if (group.fields.length > 1) assert.equal(group.gap, '16px', 'Field spacing stays 16px')
    for (let index = 1; index < group.cards.length; index++) assert.ok(Math.abs(group.cards[index].top - group.cards[index - 1].bottom - 24) < 0.6, 'Actual major card groups stay 24px apart')
  }
  if (g.group24) assert.equal(g.group24, '24px')
  result.font = await assertAppliedFont(page, 'h1', state.locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans')
  await page.addScriptTag({ content: axeSource })
  result.accessibility = await page.evaluate(async selector => (await axe.run(selector, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })), selector)
  assert.deepEqual(result.accessibility, [])
}

async function plansFlow(page, host, state, result, expect, visit) {
  host.setPlanMode('success')
  await visit('/whm/plans?planId=' + planId)
  result.plan_layout = await page.locator('#whm-plans').evaluate(section => {
    const tableRegion = section.querySelector('[data-plan-table-region]')
    const create = [...section.querySelectorAll('a.xp-btn')].find(link => !tableRegion.contains(link) && new URL(link.href).pathname === '/whm/plans' && !new URL(link.href).searchParams.has('planId'))
    const toolbar = create.closest('[data-plan-list-toolbar]') || create
    const form = section.querySelector('[data-native-plan-editor]'), wrapper = form.parentElement
    const heading = form.querySelector('h2'), firstCard = form.querySelector('.xp-card')
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const style = element => { const s = getComputedStyle(element); return { display: s.display, gap: s.rowGap, marginBlockStart: s.marginBlockStart, marginBlockEnd: s.marginBlockEnd, paddingBlockStart: s.paddingBlockStart, paddingBlockEnd: s.paddingBlockEnd, paddingInlineStart: s.paddingInlineStart, paddingInlineEnd: s.paddingInlineEnd, borderBlockStart: s.borderBlockStartWidth, borderBlockEnd: s.borderBlockEndWidth } }
    const glyph = element => { const range = document.createRange(); range.selectNodeContents(element); const r = range.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    const visibleTableContent = [...tableRegion.querySelectorAll('th,td')].filter(element => element.checkVisibility()).map(element => ({ box: rect(element), glyph: glyph(element) }))
    return {
      toolbar: rect(toolbar), create: rect(create), table: rect(tableRegion), wrapper: rect(wrapper), form: rect(form), heading: rect(heading), headingGlyph: glyph(heading), firstCard: rect(firstCard),
      toolbar_to_table: rect(tableRegion).top - rect(toolbar).bottom,
      create_to_table: rect(tableRegion).top - rect(create).bottom,
      table_to_wrapper: rect(wrapper).top - rect(tableRegion).bottom,
      table_to_form: rect(form).top - rect(tableRegion).bottom,
      table_to_heading: rect(heading).top - rect(tableRegion).bottom,
      table_to_heading_glyph: glyph(heading).top - rect(tableRegion).bottom,
      last_table_content_to_heading_glyph: glyph(heading).top - Math.max(...visibleTableContent.map(item => item.glyph.bottom)),
      sectionStyle: style(section), parentStyle: style(tableRegion.parentElement), toolbarStyle: style(toolbar), wrapperStyle: style(wrapper), formStyle: style(form), headingStyle: style(heading), firstCardStyle: style(firstCard),
      shared_parent: toolbar.parentElement === tableRegion.parentElement,
      toolbar_children: toolbar === create ? 1 : [...toolbar.children].filter(element => element.checkVisibility()).length,
    }
  })
  assert.ok(Math.abs(result.plan_layout.toolbar_to_table - 24) < 0.6, 'The actual nonempty plan toolbar and table stay 24px apart')
  assert.ok(Math.abs(result.plan_layout.create_to_table - 24) < 0.6, 'The visible Create action has the same 24px boundary without toolbar filler')
  assert.equal(result.plan_layout.shared_parent, true, 'The plan toolbar and table share one layout parent')
  assert.equal(result.plan_layout.parentStyle.display, 'flex')
  assert.equal(result.plan_layout.parentStyle.gap, '24px')
  assert.equal(result.plan_layout.toolbar_children, 1, 'The plan toolbar has one real create action and no phantom item')
  assert.ok(result.plan_layout.create.width >= 43.9 && result.plan_layout.create.height >= 43.9, 'The actual plan create target stays at least 44px')
  for (const boundary of ['table_to_wrapper', 'table_to_form', 'table_to_heading']) assert.ok(Math.abs(result.plan_layout[boundary] - 32) < 0.6, 'The real table-to-editor section boundary stays 32px without additive offsets: ' + boundary)
  result.plan_name_lines = await page.locator('#whm-plans [data-plan-name]').evaluateAll(nodes => nodes.map(node => {
    const range = document.createRange(); range.selectNodeContents(node)
    const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).reduce((tops, rect) => tops.some(top => Math.abs(top - rect.top) < 0.6) ? tops : [...tops, rect.top], [])
    return { name: node.textContent.trim(), lines: lines.length }
  }))
  assert.deepEqual(result.plan_name_lines.map(item => item.name), ['Standard', 'Alternate'])
  assert.ok(result.plan_name_lines.every(item => item.lines === 1), 'Actual single-token plan names stay intact instead of splitting into character chunks.')
  const planRegion = page.locator('[data-plan-table-region]')
  await expect(planRegion).toHaveAttribute('role', 'region'); await expect(planRegion).toHaveAttribute('tabindex', '0')
  await expect(planRegion).toHaveAccessibleName(await page.locator('#whm-plans-heading').innerText())
  const scroll = await planRegion.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, left: node.scrollLeft }))
  result.plan_table_scroll = { ...scroll, keyboard_tested: false }
  if (scroll.content > scroll.width + 1) {
    await planRegion.focus(); await expect(planRegion).toBeFocused()
    const positions = [scroll.left]
    for (const key of ['ArrowRight', 'ArrowLeft']) { await page.keyboard.press(key); await page.waitForTimeout(120); positions.push(await planRegion.evaluate(node => node.scrollLeft)) }
    assert.ok(positions.some(left => Math.abs(left - scroll.left) > 1), 'An overflowing plan table scrolls with the keyboard inside its named region.')
    result.plan_table_scroll.keyboard_tested = true; result.plan_table_scroll.positions = positions
  }
  const form = page.locator('[data-native-plan-editor]'), save = form.locator('[data-native-plan-save]'), status = form.locator('[data-native-plan-status]')
  await expect(form).toHaveAttribute('data-plan-id', planId)
  const editLink = page.locator('[data-plan-row="Standard"] a[href*="planId="]')
  const link = new URL(await editLink.getAttribute('href'), host.baseUrl)
  assert.equal(link.searchParams.get('planId'), planId); assert.equal(link.searchParams.get('lang'), state.locale); assert.equal(link.searchParams.get('theme'), state.theme)
  await expect(save).toBeDisabled()
  await form.locator('[name=name]').fill('Renamed'); await expect(save).toBeEnabled()
  await form.locator('[name=name]').fill(plan.name); await expect(save).toBeDisabled()
  await form.locator('[name=name]').fill('Renamed')
  const release = host.holdNextPlan(), start = host.requests.length
  const firstResponse = page.waitForResponse(response => response.request().method() === 'PATCH')
  try {
    await form.locator('[name=name]').press('Enter')
    await expect(form).toHaveAttribute('aria-busy', 'true')
    await form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  } finally { release() }
  await firstResponse; await expect(status).toHaveAttribute('data-state', 'pending'); await expect(save).toBeDisabled()
  const first = host.requests.slice(start).filter(request => request.method === 'PATCH')
  assert.equal(first.length, 1); assert.equal(first[0].path, '/api/plans/' + planId)
  assert.deepEqual(first[0].body, (({ id, ownerId, ...body }) => ({ ...body, name: 'Renamed' }))(plan))
  assert.equal(Object.hasOwn(first[0].body, 'ownerId'), false)
  await form.locator('[name=ioReadBps]').fill('8'); await form.locator('[name=ioWriteBps]').fill('4')
  const secondResponse = page.waitForResponse(response => response.request().method() === 'PATCH')
  await form.locator('[name=ioWriteBps]').press('Enter'); await secondResponse; await expect(status).toHaveAttribute('data-state', 'pending')
  const second = host.requests.filter(request => request.method === 'PATCH').at(-1)
  assert.equal(second.body.resources.ioReadBps, 8388608); assert.equal(second.body.resources.ioWriteBps, 4194304)
  assert.equal(second.body.name, 'Renamed'); assert.equal(second.body.featureListId, featureId); assert.equal(Object.hasOwn(second.body, 'ownerId'), false)
  host.setPlanMode('refused'); await form.locator('[name=name]').fill('Refused')
  const refusal = page.waitForResponse(response => response.request().method() === 'PATCH')
  await save.click(); await refusal; await expect(status).toHaveAttribute('data-state', 'failed'); await expect(save).toBeEnabled()
  await expect(status).not.toContainText('untrusted-synthetic-detail')
  host.setPlanMode('uncertain')
  const uncertain = page.waitForResponse(response => response.request().method() === 'PATCH')
  await save.click(); await uncertain; await expect(status).toHaveAttribute('data-state', 'failed'); await expect(save).toBeDisabled()
  const locked = host.requests.length
  await form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await expect(form).not.toHaveAttribute('aria-busy', 'true'); assert.equal(host.requests.length, locked)
  host.setPlanMode('success'); await visit('/whm/plans')
  const create = page.locator('[data-native-plan-editor]')
  assert.equal(await create.locator('[name=featureListId] option').count(), 2)
  await create.locator('[name=name]').fill('Created plan'); await create.locator('[name=featureListId]').selectOption(otherFeatureId)
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/plans')
  await create.locator('[name=name]').press('Enter'); await creation
  await expect(create.locator('[data-native-plan-status]')).toHaveAttribute('data-state', 'saved')
  const post = host.requests.filter(request => request.method === 'POST' && request.path === '/api/plans').at(-1)
  assert.equal(post.body.featureListId, otherFeatureId); assert.equal(post.body.ownerId, null)
  await expect(create).toHaveAttribute('data-plan-id', createdPlanId)
  await create.locator('[name=name]').fill('Created plan edited')
  const followup = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith(createdPlanId))
  await create.locator('[data-native-plan-save]').click(); await followup
  assert.equal(Object.hasOwn(host.requests.at(-1).body, 'ownerId'), false)
  const unknownStart = host.requests.length
  await visit('/whm/plans?planId=ffffffff-ffff-4fff-8fff-ffffffffffff')
  await expect(page.locator('[data-native-plan-editor]')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText(state.locale === 'ar' ? 'غير متاحة' : 'unavailable')
  assert.equal(host.requests.slice(unknownStart).some(request => request.method === 'POST'), false)
  result.unknown_edit_has_no_editor = true
  result.name_patch_and_separate_io_patch = true; result.io_units = { displayed: [8, 4], bytes_per_second: [8388608, 4194304] }; result.duplicate_guard = true; result.refusal_retry_and_uncertain_lock = true; result.actual_feature_list_create_and_followup_patch = true
}

async function accountsFlow(page, host, state, result, expect, visit, axeSource) {
  await visit('/whm/accounts')
  const controls = page.locator('[data-account-list-controls]')
  const rows = page.locator('[data-account-row]:visible')
  await expect(rows).toHaveCount(20); await expect(controls.locator('[data-list-page]')).toHaveText('1 / 2')
  await controls.locator('[data-list-next]').click(); await expect(rows).toHaveCount(6); await expect(controls.locator('[data-list-page]')).toHaveText('2 / 2')
  await controls.locator('[data-list-owner-filter]').selectOption('root'); await expect(rows).toHaveCount(20)
  await controls.locator('[data-list-next]').click(); await expect(rows).toHaveCount(3)
  await controls.locator('[data-list-search-input]').fill('acct22'); await expect(rows).toHaveCount(1)
  await controls.locator('[data-list-plan-filter]').selectOption(planId); await controls.locator('[data-list-state-filter]').selectOption('suspended'); await expect(rows).toHaveCount(1)
  const row = page.locator('[data-account-row=acct22]')
  await expect(row.locator('[data-account-details] summary')).toBeVisible()
  await row.locator('[data-account-details] summary').click()
  result.details_presentation = {}
  await verifyPresentation(page, state, '[data-account-details][open]', result.details_presentation, axeSource)
  await row.locator('[data-action=unsuspend-account]').click()
  const dialog = page.locator('[data-account-dialog]')
  await expect(dialog).toBeVisible(); await expect(dialog.locator('[data-account-dialog-username]')).toHaveText('acct22')
  const action = page.waitForResponse(response => response.url().endsWith('/unsuspend'))
  await dialog.locator('[data-account-action-submit]').click(); await action
  assert.equal(host.requests.at(-1).path, '/api/accounts/' + accounts[22].id + '/unsuspend')
  await expect(dialog.locator('[data-account-action-status]')).toHaveAttribute('data-state', 'failed')
  await dialog.locator('[data-account-action-cancel]').click(); await expect(row).toBeVisible()
  await controls.locator('[data-list-search-input]').fill('no-matching-account'); await expect(rows).toHaveCount(0); await expect(controls.locator('[data-list-empty]')).toBeVisible()
  await visit('/whm/accounts?actor=reseller')
  await expect(page.locator('[data-account-row]')).toHaveCount(2)
  const scopeText = await page.locator('[data-accounts-workspace]').innerText()
  assert.ok(scopeText.includes('resellalpha') && scopeText.includes('resellbeta'))
  assert.equal(scopeText.includes('private-neighbor'), false); assert.equal(scopeText.includes('acct00'), false)
  await expect(page.locator('[data-account-row=resellbeta] [data-action=unsuspend-account]')).toBeVisible()
  result.loaded_root_pages = [20, 6]; result.filtered_root_pages = [20, 3]; result.filtered_row_actions_preserved = true; result.reseller_rows = 2; result.neighbor_absent = true
}

async function mailFlow(page, host, state, result, expect, visit) {
  host.setMailMode('success'); await visit('/whm/email/outbound')
  let form = page.locator('[data-mail-ip-config-form]'), save = form.locator('button[type=submit]')
  await expect(save).toBeDisabled(); await form.locator('[name=defaultIpv4]').fill('192.0.2.99')
  const before = host.requests.length, response = page.waitForResponse(response => response.request().method() === 'PUT')
  await form.locator('[name=defaultIpv4]').press('Enter'); await response
  await expect(form.locator('[data-mail-ip-status]')).toHaveAttribute('data-state', 'pending'); await expect(save).toBeDisabled()
  const requests = host.requests.slice(before)
  assert.deepEqual(requests.map(request => [request.method, request.path]), [['GET', '/api/mail/ips'], ['PUT', '/api/mail/ips']])
  assert.deepEqual(requests[1].body, { ...freshMail, defaultIpv4: '192.0.2.99' })
  await expect(form.locator('[data-mail-ip-overrides]')).toContainText('fresh.example.test')
  assert.equal((await form.locator('[data-mail-ip-status]').innerText()).includes(state.locale === 'ar' ? 'غير مؤكد' : 'not confirmed'), true)
  host.setMailMode('get-failed'); await visit('/whm/email/outbound')
  form = page.locator('[data-mail-ip-config-form]'); save = form.locator('button[type=submit]')
  await form.locator('[name=defaultIpv4]').fill('192.0.2.98')
  const blocked = host.requests.length, failedRead = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/mail/ips'))
  await save.click(); await failedRead; await expect(form.locator('[data-mail-ip-status]')).toHaveAttribute('data-state', 'failed')
  await expect(save).toBeEnabled(); assert.deepEqual(host.requests.slice(blocked).map(request => request.method), ['GET'])
  host.setMailMode('success'); await visit('/whm/email/outbound')
  form = page.locator('[data-mail-ip-config-form]'); await form.locator('[name=defaultHelo]').fill('requested-mail.example.test')
  const conflictStart = host.requests.length, conflict = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/mail/ips'))
  await form.locator('button[type=submit]').click(); await conflict; await expect(form.locator('[data-mail-ip-status]')).toHaveAttribute('data-state', 'failed')
  assert.deepEqual(host.requests.slice(conflictStart).map(request => request.method), ['GET'])
  host.setMailMode('uncertain'); await visit('/whm/email/outbound')
  form = page.locator('[data-mail-ip-config-form]'); await form.locator('[name=defaultIpv4]').fill('192.0.2.97')
  const unknown = page.waitForResponse(response => response.request().method() === 'PUT')
  await form.locator('button[type=submit]').click(); await unknown
  await expect(form.locator('[data-mail-ip-status]')).toHaveAttribute('data-state', 'failed'); await expect(form.locator('button[type=submit]')).toBeDisabled()
  const locked = host.requests.length; await form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await expect(form).not.toHaveAttribute('aria-busy', 'true'); assert.equal(host.requests.length, locked)
  result.fresh_get_before_put = true; result.full_fresh_map_and_unedited_server_fields_preserved = true; result.failed_get_and_conflict_send_no_put = true; result.uncertain_receipt_locks_retry = true; result.smtp_or_delivery_not_qualified = true
}

export async function runNativeWorkflowsAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim())
  requireBrowserDiskHeadroom(root, 384)
  const destination = resolve(root, output || 'test-results/native-workflows-' + new Date().toISOString().replaceAll(':', '-'))
  const path = relative(root, destination)
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || existsSync(destination)) throw new Error('Choose a fresh repository-relative output directory')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(), results = [], host = await fixture()
  writeFileSync(join(destination, 'source-before.json'), JSON.stringify(before, null, 2) + '\n')
  const { chromium, expect } = await import('@playwright/test')
  let browser, captures = 0, failureCaptures = 0
  const axeSource = readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8')
  const flows = [['plans', '/whm/plans?planId=' + planId, '[data-native-plan-editor]', plansFlow], ['accounts', '/whm/accounts', '[data-accounts-workspace]', accountsFlow], ['outbound', '/whm/email/outbound', '[data-mail-ip-config-form]', mailFlow]]
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || chromium.executablePath(), timeout: 20000 })
    for (const state of states) for (const [name, initialPath, selector, run] of flows.filter(([name]) => !filter || name.includes(filter))) {
        requireBrowserDiskHeadroom(root, 256, destination)
      const result = { name, ...state, synthetic_api_only: true, page_errors: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: 900 }, reducedMotion: 'reduce', locale: state.locale, colorScheme: state.theme })
      const page = await context.newPage(); page.setDefaultTimeout(8000)
      page.on('pageerror', error => result.page_errors.push(error.message))
      page.on('dialog', dialog => dialog.accept())
      const visit = async path => {
        const url = new URL(path, host.baseUrl); url.searchParams.set('lang', state.locale); url.searchParams.set('theme', state.theme)
        const response = await page.goto(url.href, { waitUntil: 'networkidle' })
        assert.equal(response.status(), 200); assert.equal(await page.locator('html').getAttribute('data-native-workflow-fixture'), 'synthetic-qualified-presentation')
        await page.waitForFunction(() => typeof window.xpanelSessionRequest === 'function')
      }
      const requestStart = host.requests.length
      try {
        await visit(initialPath)
        if (name === 'outbound') {
          const expected = baseMail.domainOverrides.map(item => [item.domainName, item.ipv4, item.ipv6, item.heloHostname].filter(Boolean).join(' · ')).join('\n')
          const actual = await page.locator('[data-mail-ip-overrides]').textContent()
          assert.equal(actual, expected, 'The full readonly override text, including every whitespace character, stays identical to the fixture.')
          result.readonly_text_identity = { exact: true, characters: actual.length, whitespace_preserved: true }
        }
        await verifyPresentation(page, state, selector, result, axeSource)
        if (captures < 8) { const screenshot = `representative-${name}-${state.locale}-${state.width}.png`; await page.screenshot({ path: join(destination, 'screenshots', screenshot), fullPage: false }); result.screenshot = screenshot; captures++ }
        await run(page, host, state, result, expect, visit, axeSource)
        result.requests = host.requests.slice(requestStart)
        for (const request of result.requests.filter(request => !['GET', 'HEAD'].includes(request.method))) {
          assert.equal(request.csrf, 'synthetic-native-csrf'); assert.equal(request.contentType, 'application/json')
        }
        assert.deepEqual(result.page_errors, [])
        result.passed = true
      } catch (error) {
        result.passed = false; result.error = String(error.stack || error); result.requests = host.requests.slice(requestStart)
        if (failureCaptures < 8) { const screenshot = `failure-${name}-${state.locale}-${state.width}.png`; await page.screenshot({ path: join(destination, 'screenshots', screenshot), fullPage: false }).catch(() => {}); result.screenshot = screenshot; failureCaptures++ }
      } finally { await context.close() }
      results.push(result)
      writeFileSync(join(destination, 'results.json'), JSON.stringify({ complete: false, results }, null, 2) + '\n')
    }
  } finally { await browser?.close(); await host.close() }
  assert.ok(results.length > 0, 'The selected workflow filter must run actual cases')
  const after = fingerprint()
  writeFileSync(join(destination, 'source-after.json'), JSON.stringify(after, null, 2) + '\n')
  const summary = { complete: true, node: process.version, browser: browser.version(), source_before: before.sha256, source_after: after.sha256, source_drift: before.sha256 !== after.sha256, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, cases: results.length, screenshots: captures, failure_screenshots: failureCaptures, limitations: ['Synthetic qualified presentation and loopback API only; no real authentication, SMTP, host operations or service qualification.', 'Dark phone and light desktop; inverse theme/viewport combinations are not claimed.', 'Native input glyph coordinates are not inferred from a mirror: input box alignment and readonly actual glyph alignment are recorded separately.'], results }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
  assert.equal(summary.source_drift, false, 'Acceptance requires a globally frozen candidate')
  assert.equal(summary.failed, 0, 'All selected native workflow cases must pass')
  return { output: destination, passed: summary.passed, cases: summary.cases, source_drift: summary.source_drift }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.find(argument => argument.startsWith('--' + name + '='))?.split('=').slice(1).join('=')
  runNativeWorkflowsAcceptance({ output: option('output'), filter: option('filter') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
