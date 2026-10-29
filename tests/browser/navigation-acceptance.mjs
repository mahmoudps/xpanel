import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as requestFontHttps } from 'node:https'
import { Transform as FontTransform, Writable as FontWritable } from 'node:stream'
import { pipeline as fontPipeline } from 'node:stream/promises'
import { createGunzip, createInflate, createBrotliDecompress, createZstdDecompress } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { createVisualFixture } from './visual-fixture.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const focusable = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]'
const routes = [
  { path: '/home', to: '/domains', marker: '[data-board-port="xpanel-home"]', target: '[data-domains-table]' },
  { path: '/whm', to: '/whm/accounts', marker: '[data-section="overview-attention"]', target: '[data-section="accounts-isolation"]' },
  { path: '/mail/inbox', to: '/mail/compose', marker: '[data-mail-pane="message-list"]', target: '[data-compose-form]' },
  { path: '/files/manager', to: '/home', marker: '[data-file-manager-table]', target: '[data-board-port="xpanel-home"]' },
]
const states = routes.flatMap(route => [360, 768, 1280, 1440].flatMap(width => ['en', 'ar'].map(locale => ({
  id: `navigate-${route.path.replaceAll('/', '-').replace(/^-/, '')}-${locale}-${width}`, kind: 'navigation', ...route, width, locale,
}))))
for (const locale of ['en', 'ar']) {
  for (const width of [390, 1440]) states.push({ id: `audit-spacing-${locale}-${width}`, kind: 'audit-spacing', path: '/whm/audit', width, locale })
  for (const boundary of ['sheet-close', 'toolbar-summary', 'palette-return']) states.push({ id: `boundary-${boundary}-${locale}`, kind: boundary, path: '/domains', width: boundary === 'palette-return' ? 960 : 959, locale })
  for (const [kind, width] of [['home-sheet-close', 800], ['home-palette-return', 801]]) states.push({ id: `boundary-${kind}-${locale}`, kind, path: '/home', width, locale })
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
  for (const width of [360, 1440]) states.push({ id: `palette-alias-${locale}-${width}`, kind: 'palette-alias', path: '/home', width, locale })
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

async function homePhone(page) {
  return await page.locator('[data-home-phone]:visible').count() > 0
}

async function navigationRoot(page, { openHome = false } = {}) {
  if (await homePhone(page)) {
    if (openHome && await page.locator('#xpanel-home-menu').getAttribute('aria-expanded') !== 'true') await page.locator('#xpanel-home-menu').click()
    return page.locator('#m-drawer nav')
  }
  const visible = page.locator('[data-xp-sidebar]:visible')
  return await visible.count() ? visible.first() : page.locator('[data-xp-sidebar]').first()
}

async function assertHomeNavigationClosed(page, expect) {
  if (!await homePhone(page)) return
  await expect(page.locator('#xpanel-home-menu')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#m-drawer')).toBeHidden()
  assert.equal(await page.locator('[data-home-phone] > header').evaluate(element => element.inert), false)
  assert.equal(await page.locator('[data-home-phone] > main').evaluate(element => element.inert), false)
}

async function currentPage(page, path, expect) {
  const phone = await homePhone(page)
  const wasClosed = phone && await page.locator('#xpanel-home-menu').getAttribute('aria-expanded') !== 'true'
  const navigation = await navigationRoot(page, { openHome: phone })
  const active = navigation.locator('a[aria-current="page"]')
  await expect(active).toHaveCount(1)
  assert.equal(new URL(await active.getAttribute('href'), page.url()).pathname, path, 'The current item in the active responsive navigation must match the actual document')
  assert.equal(await active.getAttribute('data-nav-route'), path)
  if (wasClosed) {
    await page.keyboard.press('Escape')
    await expect(page.locator('#xpanel-home-menu')).toBeFocused()
    await expect(page.locator('#xpanel-home-menu')).toHaveAttribute('aria-expanded', 'false')
  }
}

const NAV_FONT_LIMITS = Object.freeze({ deadlineMs: 60_000, cssUrls: 1, fontUrls: 64, variantsPerUrl: 2, responses: 130, cssBytes: 256 * 1024, fontBytes: 1024 * 1024, aggregateBytes: 16 * 1024 * 1024, concurrency: 4, htmlBytes: 2 * 1024 * 1024 })
const NAV_FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'])
const NAV_FONT_SENSITIVE = new Set(['cookie', 'cookie2', 'authorization', 'proxy-authorization'])
const NAV_FONT_HOP = new Set(['host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length'])
const fontHash = value => createHash('sha256').update(value).digest('hex')
const fontFailure = code => Object.assign(new Error(code), { fontCode: code })
const fontLocation = value => { const url = new URL(value); return { origin: url.origin, pathname: url.pathname, url_sha256: fontHash(url.href) } }
function fontAssetUrl(value, kind) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href.length > 4096) throw fontFailure('unsafe-font-url')
  if (kind === 'css' ? url.origin !== 'https://fonts.googleapis.com' || url.pathname !== '/css2' : url.origin !== 'https://fonts.gstatic.com' || !/^\/s\/[a-z0-9]+\/v[0-9]+\/[A-Za-z0-9_-]+\.woff2$/.test(url.pathname)) throw fontFailure('unapproved-font-url')
  return url.href
}
const fontDecodeAttribute = value => value.replaceAll('&amp;', '&')
function fontInputsFromHtml(html) {
  const css = new Set(), fonts = new Set()
  for (const match of html.matchAll(/<link\b([^>]+)>/gi)) {
    const attr = name => match[1].match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"', 'i'))?.[1] ?? ''
    if (attr('rel').split(/\s+/).includes('stylesheet')) css.add(fontAssetUrl(fontDecodeAttribute(attr('href')), 'css'))
  }
  for (const match of html.matchAll(/@font-face\s*\{([^{}]+)\}/gi)) {
    for (const source of match[1].matchAll(/url\(\s*['"]?(https:\/\/[^)'"\s]+)['"]?\s*\)/g)) fonts.add(fontAssetUrl(source[1], 'font'))
  }
  return { css, fonts }
}
function fontsFromCss(bytes) {
  let css
  try { css = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw fontFailure('invalid-font-css-encoding') }
  if (/@import\b/i.test(css)) throw fontFailure('font-css-import-unsupported')
  const fonts = new Set(), faces = [...css.matchAll(/@font-face\s*\{([^{}]+)\}/gi)]
  if (!faces.length || faces.length > 128) throw fontFailure('font-css-face-count')
  const families = new Set()
  for (const face of faces) {
    const family = face[1].match(/font-family:\s*['"]([^'"]+)['"]/i)?.[1]
    if (family) families.add(family)
    const src = face[1].match(/\bsrc\s*:\s*([^;]+);/i)?.[1] ?? ''
    if (/local\s*\(/i.test(src) || !/format\(\s*['"]woff2['"]\s*\)/i.test(src)) throw fontFailure('font-css-source-format')
    const urls = [...src.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)]
    if (!urls.length) throw fontFailure('font-css-source-missing')
    for (const url of urls) fonts.add(fontAssetUrl(url[1], 'font'))
  }
  for (const family of ['IBM Plex Sans', 'IBM Plex Mono']) if (!families.has(family)) throw fontFailure('font-css-family-missing')
  const allUrls = [...css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map(match => fontAssetUrl(match[1], 'font'))
  if (allUrls.some(url => !fonts.has(url))) throw fontFailure('font-css-extra-resource')
  return fonts
}
function fontHeaders(raw) {
  const headers = {}
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase()
    if (NAV_FONT_SENSITIVE.has(key) && value) throw fontFailure('credentialed-font-request')
    if (!NAV_FONT_SENSITIVE.has(key) && !NAV_FONT_HOP.has(key) && /^[a-z0-9-]+$/.test(key)) headers[key] = String(value)
  }
  if (!headers['user-agent']) throw fontFailure('font-user-agent-missing')
  return headers
}
const sameFontVariant = (entry, headers) => entry.userAgent === headers['user-agent'] && entry.vary.every(name => (entry.requestHeaders[name] ?? null) === (headers[name] ?? null))
const fontVariantKey = (vary, headers) => fontHash(JSON.stringify([headers['user-agent'], ...vary.map(name => [name, headers[name] ?? null])]))
async function fetchFontResponse(url, kind, headers, state) {
  state.signal.throwIfAborted()
  if (++state.responses > NAV_FONT_LIMITS.responses) throw fontFailure('font-response-count-limit')
  const limit = kind === 'css' ? NAV_FONT_LIMITS.cssBytes : NAV_FONT_LIMITS.fontBytes
  return await new Promise((resolveResponse, rejectResponse) => {
    const request = requestFontHttps(url, { method: 'GET', headers, signal: state.signal, rejectUnauthorized: true, maxHeaderSize: 16384 }, response => {
      ;(async () => {
        try {
          if (response.statusCode !== 200) throw fontFailure('font-response-not-200')
          if (response.headers['set-cookie'] || response.headers['set-cookie2'] || response.headers['www-authenticate'] || response.headers['proxy-authenticate']) throw fontFailure('credentialed-font-response')
          const mime = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
          if (mime !== (kind === 'css' ? 'text/css' : 'font/woff2')) throw fontFailure('font-response-mime')
          const vary = [...new Set(String(response.headers.vary ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean))].sort()
          if (vary.length > 32 || vary.some(name => !/^[a-z0-9-]+$/.test(name) || NAV_FONT_SENSITIVE.has(name) || NAV_FONT_HOP.has(name))) throw fontFailure('font-response-vary-unsupported')
          const length = response.headers['content-length']
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit)) throw fontFailure('font-wire-byte-limit')
          const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
          const decoder = encoding === 'identity' ? null : encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : encoding === 'zstd' ? createZstdDecompress() : null
          if (encoding !== 'identity' && !decoder) throw fontFailure('font-content-encoding-unsupported')
          let wireBytes = 0, decodedBytes = 0
          const chunks = []
          const wire = new FontTransform({ transform(chunk, _encoding, callback) {
            wireBytes += chunk.length; state.wireBytes += chunk.length
            callback(wireBytes > limit || state.wireBytes > NAV_FONT_LIMITS.aggregateBytes ? fontFailure('font-wire-byte-limit') : null, chunk)
          } })
          const sink = new FontWritable({ write(chunk, _encoding, callback) {
            decodedBytes += chunk.length; state.decodedBytes += chunk.length
            if (decodedBytes > limit || state.decodedBytes > NAV_FONT_LIMITS.aggregateBytes) { callback(fontFailure('font-decoded-byte-limit')); return }
            chunks.push(Buffer.from(chunk)); callback()
          } })
          await fontPipeline([response, wire, ...(decoder ? [decoder] : []), sink], { signal: state.signal })
          const body = Buffer.concat(chunks, decodedBytes)
          if (!body.length) throw fontFailure('font-response-empty')
          if (kind === 'font' && (body.length < 48 || body.toString('ascii', 0, 4) !== 'wOF2' || body.readUInt32BE(8) !== body.length)) throw fontFailure('font-woff2-invalid')
          const responseHeaders = {}
          const connectionTokens = String(response.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined && !NAV_FONT_HOP.has(name) && name !== 'content-encoding' && !connectionTokens.includes(name)) responseHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value)
          }
          if (kind === 'font' && responseHeaders['access-control-allow-origin'] !== '*' && !(typeof headers.origin === 'string' && responseHeaders['access-control-allow-origin'] === headers.origin)) throw fontFailure('font-cors-invalid')
          resolveResponse({ url, kind, body, bodyHash: fontHash(body), mime, status: 200, vary, userAgent: headers['user-agent'], requestHeaders: Object.freeze({ ...headers }), headers: Object.freeze(responseHeaders), variantKey: fontVariantKey(vary, headers), wireBytes, replayCount: 0 })
        } finally { response.destroy() }
      })().catch(rejectResponse)
    })
    request.on('error', rejectResponse)
    request.end()
  })
}
async function fontMapLimited(jobs, state, work) {
  let index = 0
  const workers = Array.from({ length: Math.min(NAV_FONT_LIMITS.concurrency, jobs.length) }, async () => { while (index < jobs.length) { state.signal.throwIfAborted(); await work(jobs[index++]) } })
  try { await Promise.all(workers) } catch (error) { state.controller.abort(error); await Promise.allSettled(workers); throw error }
}
async function prepareNavigationFontTransport(browser, fixture, unqualifiedFixture) {
  const started = Date.now(), controller = new AbortController()
  const state = { controller, signal: controller.signal, wireBytes: 0, decodedBytes: 0, responses: 0 }
  const timer = setTimeout(() => controller.abort(fontFailure('font-preparation-deadline')), NAV_FONT_LIMITS.deadlineMs)
  const assets = new Map(), cssUrls = new Set(), fontUrls = new Set(), inlineFontUrls = new Set(), provenance = new Map(), profiles = { css: [], font: [] }
  const addProvenance = (url, value) => { const rows = provenance.get(url) ?? new Map(); rows.set(JSON.stringify(value), value); provenance.set(url, rows) }
  let phase = 'inventory', effectiveUserAgent = '', cdpUserAgent = '', probes = 0
  const remaining = () => { state.signal.throwIfAborted(); return Math.max(1, NAV_FONT_LIMITS.deadlineMs - (Date.now() - started)) }
  const addProfile = (kind, headers) => { const key = fontHash(JSON.stringify(Object.entries(headers).sort())); if (!profiles[kind].some(profile => profile.key === key)) { if (profiles[kind].length >= 16) throw fontFailure('font-header-profile-count'); profiles[kind].push({ key, headers }) } }
  const report = status => ({ status, phase, duration_ms: Date.now() - started, limits: NAV_FONT_LIMITS, transport: 'prepared-https-entity-byte-replay', cold_cdn_performance_qualified: false, browser_user_agent_sha256: effectiveUserAgent ? fontHash(effectiveUserAgent) : null, cdp_user_agent_sha256: cdpUserAgent ? fontHash(cdpUserAgent) : null, metadata_only_probes: probes, unique_css_urls: cssUrls.size, unique_font_urls: fontUrls.size, direct_inline_font_url_hashes: [...inlineFontUrls].map(fontHash).sort(), response_count: state.responses, wire_bytes: state.wireBytes, decoded_bytes: state.decodedBytes, assets: [...assets.values()].flatMap(entries => entries.map(entry => ({ ...fontLocation(entry.url), kind: entry.kind, status: entry.status, mime: entry.mime, bytes: entry.body.length, wire_bytes: entry.wireBytes, body_sha256: entry.bodyHash, discovered_from: [...(provenance.get(entry.url)?.values() ?? [])], vary_vector_sha256: entry.variantKey, replay_count: entry.replayCount }))) })
  const ensure = async (url, kind, headers) => {
    const entries = assets.get(url) ?? []
    if (entries.some(entry => sameFontVariant(entry, headers))) return
    if (entries.length >= NAV_FONT_LIMITS.variantsPerUrl) throw fontFailure('font-variant-count-limit')
    const entry = await fetchFontResponse(url, kind, headers, state)
    entries.push(entry); assets.set(url, entries)
    if (kind === 'css') for (const font of fontsFromCss(entry.body)) {
      fontUrls.add(font)
      addProvenance(font, { kind: 'stylesheet-font-face', stylesheet_url_sha256: fontHash(url), stylesheet_body_sha256: entry.bodyHash })
    }
    if (fontUrls.size > NAV_FONT_LIMITS.fontUrls) throw fontFailure('font-url-count-limit')
  }
  const probe = async (baseUrl, locale, withCss) => {
    phase = withCss ? 'font-header-probe' : 'css-header-probe'; probes++
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const abort = () => { void context.close().catch(() => {}) }
    state.signal.addEventListener('abort', abort, { once: true })
    let probeError = null
    try {
      await context.route('**/*', async route => {
        try {
          const request = route.request(), url = new URL(request.url())
          if (!['GET', 'HEAD'].includes(request.method())) { await route.abort(); return }
          if (!NAV_FONT_ORIGINS.has(url.origin)) { if (url.origin !== new URL(baseUrl).origin) { await route.abort(); return } await route.continue(); return }
          if (request.method() !== 'GET') throw fontFailure('font-probe-method')
          const headers = fontHeaders(await request.allHeaders())
          if (!effectiveUserAgent) effectiveUserAgent = headers['user-agent']
          if (headers['user-agent'] !== effectiveUserAgent) throw fontFailure('font-user-agent-varies')
          if (cssUrls.has(url.href) && request.resourceType() === 'stylesheet') {
            addProfile('css', headers)
            if (withCss) {
              const entry = (assets.get(url.href) ?? []).find(value => sameFontVariant(value, headers))
              if (!entry) throw fontFailure('font-css-probe-variant-missing')
              await route.fulfill({ status: entry.status, headers: entry.headers, body: entry.body }); return
            }
          } else if (fontUrls.has(url.href) && request.resourceType() === 'font') addProfile('font', headers)
          else throw fontFailure('font-probe-unapproved-resource')
          await route.abort()
        } catch (error) { probeError ??= error; await route.abort().catch(() => {}) }
      })
      const page = await context.newPage(), url = new URL('/home', baseUrl)
      for (const [key, value] of Object.entries({ lang: locale, theme: 'light', density: 'compact', accountId: 'visual-account' })) url.searchParams.set(key, value)
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: remaining() })
      await page.evaluate(async () => { await document.fonts.ready })
      if (probeError) throw probeError
      state.signal.throwIfAborted()
    } finally { state.signal.removeEventListener('abort', abort); await context.close() }
  }
  try {
    const cdp = await browser.newBrowserCDPSession()
    try { cdpUserAgent = (await cdp.send('Browser.getVersion')).userAgent } finally { await cdp.detach() }
    for (const path of ['/home', '/whm/accounts/new', '/mail/compose', '/login']) for (const locale of ['en', 'ar']) {
      const url = new URL(path, fixture.baseUrl); url.searchParams.set('lang', locale)
      const response = await fetch(url, { signal: state.signal })
      if (response.status !== 200) throw fontFailure('font-inventory-document-status')
      const chunks = []; let bytes = 0
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > NAV_FONT_LIMITS.htmlBytes) throw fontFailure('font-inventory-document-size'); chunks.push(chunk) }
      const html = Buffer.concat(chunks), input = fontInputsFromHtml(html.toString('utf8')), documentHash = fontHash(html)
      for (const value of input.css) { cssUrls.add(value); addProvenance(value, { kind: 'rendered-stylesheet-link', path, locale, document_sha256: documentHash }) }
      for (const value of input.fonts) { fontUrls.add(value); inlineFontUrls.add(value); addProvenance(value, { kind: 'rendered-inline-font-face', path, locale, document_sha256: documentHash }) }
    }
    if (cssUrls.size !== NAV_FONT_LIMITS.cssUrls || fontUrls.size !== 4) throw fontFailure('font-inventory-source-changed')
    for (const target of [fixture, unqualifiedFixture]) await probe(target.baseUrl, 'en', false)
    if (!profiles.css.length) throw fontFailure('font-css-header-profile-missing')
    phase = 'css-fetch'
    for (const url of cssUrls) for (const profile of profiles.css) await ensure(url, 'css', profile.headers)
    for (const target of [fixture, unqualifiedFixture]) for (const locale of ['en', 'ar']) await probe(target.baseUrl, locale, true)
    if (!profiles.font.length) throw fontFailure('font-header-profile-missing')
    phase = 'font-fetch'
    await fontMapLimited([...fontUrls], state, async url => { for (const profile of profiles.font) await ensure(url, 'font', profile.headers) })
    phase = 'ready'
    const preparationDuration = Date.now() - started
    return {
      report() { return { ...report('ready'), duration_ms: preparationDuration } },
      async replay(route, errors) {
        const request = route.request(), url = new URL(request.url())
        if (!NAV_FONT_ORIGINS.has(url.origin)) return false
        const reject = async code => { if (errors.length < 16) errors.push({ code, ...fontLocation(url.href) }); else if (errors.length === 16) errors.push({ code: 'font-violations-truncated' }); await route.abort(); return true }
        if (request.method() !== 'GET') return await reject('font-replay-method')
        const kind = request.resourceType() === 'stylesheet' ? 'css' : request.resourceType() === 'font' ? 'font' : null
        if (!kind) return await reject('font-replay-resource-type')
        let headers
        try { headers = fontHeaders(await request.allHeaders()) } catch { return await reject('font-replay-credentialed-headers') }
        const entry = (assets.get(url.href) ?? []).find(value => value.kind === kind && sameFontVariant(value, headers))
        if (!entry) return await reject('font-replay-variant-missing')
        if (fontHash(entry.body) !== entry.bodyHash) return await reject('font-replay-body-integrity')
        entry.replayCount++
        await route.fulfill({ status: entry.status, headers: entry.headers, body: entry.body })
        return true
      },
    }
  } catch (error) {
    controller.abort(error)
    const failure = fontFailure(error.fontCode ?? (state.signal.reason?.fontCode === 'font-preparation-deadline' ? 'font-preparation-deadline' : 'font-preparation-transport-failed'))
    failure.preparation = report('blocked'); throw failure
  } finally { clearTimeout(timer) }
}
// Observe requests without changing routing, cache, retry or timeout behavior.
// Serialize this bounded, sanitized evidence only when a case fails.
function failureNetworkDiagnostics(page) {
  const caps = { pending: 64, events: 128, origin_chars: 256, pathname_chars: 512 }
  const pending = new Map(), events = []
  const observed = { started: 0, finished: 0, failed: 0 }
  const dropped = { pending_starts: 0, event_records: 0, url_parts: 0 }
  const startedAt = performance.now()
  const describe = request => {
    let url = { scheme: null, origin: null, pathname: null, omitted: true, truncated: false }
    try {
      const parsed = new URL(request.url())
      url.scheme = ['http:', 'https:'].includes(parsed.protocol) ? parsed.protocol : 'other'
      if (url.scheme !== 'other') {
        const truncated = parsed.origin.length > caps.origin_chars || parsed.pathname.length > caps.pathname_chars
        url = { scheme: parsed.protocol, origin: parsed.origin.slice(0, caps.origin_chars), pathname: parsed.pathname.slice(0, caps.pathname_chars), omitted: false, truncated }
        if (truncated) dropped.url_parts++
      }
    } catch { /* Never retain an invalid raw URL or a non-HTTP payload. */ }
    return { url, resource_type: request.resourceType(), is_navigation: request.isNavigationRequest() }
  }
  const record = entry => {
    if (events.length === caps.events) { events.shift(); dropped.event_records++ }
    events.push(entry)
  }
  page.on('request', request => {
    const at = performance.now(), metadata = describe(request)
    observed.started++
    if (pending.size < caps.pending) pending.set(request, { ...metadata, at })
    else dropped.pending_starts++
    record({ phase: 'started', at_ms: Math.round(at - startedAt), age_ms: 0, ...metadata })
  })
  const settled = (request, phase) => {
    const at = performance.now(), item = pending.get(request)
    const metadata = item ? { url: item.url, resource_type: item.resource_type, is_navigation: item.is_navigation } : describe(request)
    pending.delete(request)
    observed[phase]++
    const code = phase === 'failed' ? request.failure()?.errorText : null
    record({ phase, at_ms: Math.round(at - startedAt), age_ms: item ? Math.max(0, Math.round(at - item.at)) : null, ...metadata, ...(phase === 'failed' ? { error_code: typeof code === 'string' && /^net::ERR_[A-Z0-9_]+$/.test(code) ? code : null } : {}) })
  }
  page.on('requestfinished', request => settled(request, 'finished'))
  page.on('requestfailed', request => settled(request, 'failed'))
  return {
    snapshot() {
      const now = performance.now()
      return {
        scope: 'Failure-only request metadata; no query, fragment, credentials, headers, cookies or body',
        elapsed_ms: Math.round(now - startedAt), caps: { ...caps }, observed: { ...observed }, dropped: { ...dropped },
        truncated: Object.values(dropped).some(count => count > 0),
        pending: [...pending.values()].map(item => ({ url: item.url, resource_type: item.resource_type, is_navigation: item.is_navigation, started_ms: Math.round(item.at - startedAt), age_ms: Math.max(0, Math.round(now - item.at)) })),
        events: events.map(entry => ({ ...entry })),
      }
    },
  }
}

async function fontGate(page, locale) {
  const result = await page.evaluate(async locale => {
    const family = locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans'
    const text = locale === 'ar' ? 'الحساب 0123456789' : 'Account 0123456789'
    let ready = false
    await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 10000))])
    const faces = [...document.fonts].map(face => ({ family: face.family.replaceAll('"', '').replaceAll("'", ''), status: face.status }))
    return { ready, status: document.fonts.status, family, glyph_check: document.fonts.check(family === 'sans-serif' ? '14px sans-serif' : `14px "${family}"`, text), body_family: getComputedStyle(document.body).fontFamily, faces }
  }, locale)
  assert.equal(result.ready, true, 'Font loading must finish within the recorded observation window')
  assert.equal(result.status, 'loaded')
  if (locale === 'en') assert.ok(result.faces.some(face => face.family === result.family && face.status === 'loaded'), 'The expected downloadable English locale face must actually load')
  assert.equal(result.glyph_check, true)
  if (locale === 'ar') assert.equal(result.body_family, 'sans-serif', 'Arabic UI must select the literal generic sans-serif family')
  else assert.ok(result.body_family.includes(result.family), 'The locale body must select its intended family')
  assert.deepEqual(result.faces.filter(face => face.status === 'error'), [])
  result.applied_ui = await assertAppliedFont(page, 'h1', result.family)
  return result
}

async function usableFocus(page) {
  return page.evaluate(() => {
    const target = document.activeElement
    return { tag: target?.tagName, action: target?.getAttribute('data-action'), id: target?.id, visible: !!target && target !== document.body && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]') }
  })
}

async function openUserMenu(page) {
  const menu = page.locator('details[data-user-menu]').filter({ visible: true }).first()
  if (await menu.count() && !await menu.evaluate(element => element.open)) await menu.locator(':scope > summary').click()
}

async function openToolbar(page) {
  const toolbar = page.locator('[data-xp-toolbar-options]')
  if (!await toolbar.count()) return
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
  const phone = await homePhone(page)
  const toggle = page.locator(phone ? '#xpanel-home-menu' : '[data-action="toggle-mobile-nav"]')
  if (!phone && !await toggle.isVisible()) {
    const boards = page.locator('[data-home-desktop]:visible,[data-board-port="xwhm-dashboard"]:visible,[data-board-port="xmail-inbox"]:visible,[data-board-port="xmail-compose"]:visible')
    assert.equal(await boards.count(), 1, 'Only an explicit current board may use inline navigation; shared shells must expose their modal toggle')
    const navigation = await navigationRoot(page)
    await expect(navigation).toBeVisible()
    assert.notEqual(await navigation.getAttribute('aria-modal'), 'true', 'Inline navigation must not claim dialog modality')
    const endpoints = await navigation.evaluate((element, selector) => [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]')).map(target => target.getAttribute('href') ?? target.tagName), focusable)
    assert.ok(endpoints.length > 1, 'Inline navigation must contain usable keyboard destinations')
    const links = navigation.locator('a[href]:visible')
    await links.first().focus()
    await expect(links.first()).toBeFocused()
    await page.keyboard.press('Tab')
    assert.equal((await usableFocus(page)).visible, true)
    observations.push({ check: 'inline-navigation-keyboard', destinations: endpoints.length, native_tab_flow: true, modal: false })
    return
  }
  const sidebar = page.locator(phone ? '#m-drawer' : '[data-xp-sidebar]')
  const background = page.locator(phone ? '[data-home-phone] > main' : '[data-xp-shell-content]')
  await page.evaluate(long => window.scrollTo(0, long ? Math.min(180, document.documentElement.scrollHeight - innerHeight) : 0), requireLongScroll)
  await frames(page)
  const before = await page.evaluate(() => ({ y: scrollY, maximum: document.documentElement.scrollHeight - innerHeight, scroll_height: document.documentElement.scrollHeight, client_height: document.documentElement.clientHeight, body_height: document.body.getBoundingClientRect().height }))
  if (requireLongScroll) assert.ok(before.maximum > 100 && before.y > 100, 'Long-form scroll preservation must observe more than fixture-watermark overflow')
  const opening = await observeAction(page, () => toggle.click())
  await expect(sidebar).toHaveAttribute('role', 'dialog')
  await expect(sidebar).toHaveAttribute('aria-modal', 'true')
  assert.equal(await background.evaluate(element => element.inert), true)
  if (phone) assert.equal(await page.locator('[data-home-phone] > header').evaluate(element => element.inert), true)
  assert.equal(await sidebar.evaluate(element => element.contains(document.activeElement)), true)
  const trace = []
  observations.push({ check: 'focus-scroll-stages', trace })
  const record = async step => { await frames(page); trace.push(await sidebar.evaluate((element, step) => ({ step, y: scrollY, focus_tag: document.activeElement?.tagName, focus_action: document.activeElement?.getAttribute('data-action'), sidebar_y: element.scrollTop }), step)) }
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
  assert.equal(await background.evaluate(element => element.inert), false)
  if (phone) assert.equal(await page.locator('[data-home-phone] > header').evaluate(element => element.inert), false)
  const after = await page.evaluate(() => scrollY)
  observations.push({ check: 'mobile-overlay', surface: phone ? 'home' : 'shared', focus_destinations: endpoints.count, long_form_scroll: requireLongScroll, scroll_maximum: before.maximum, scroll_before: before.y, scroll_before_escape: beforeClosing, scroll_after: after, opening, closing })
  assert.ok(Math.abs(after - before.y) <= 1, `Escape must preserve the real document scroll position (${before.y} to ${after})`)
}

async function navigate(page, state, expect, observations) {
  await currentPage(page, state.path, expect)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.path, expect)
  assertContext(page.url(), state)
  if (state.width < 960) await mobileOverlay(page, expect, observations)
  const phone = await homePhone(page)
  if (!phone && await page.locator('[data-action="toggle-mobile-nav"]').isVisible()) await page.locator('[data-action="toggle-mobile-nav"]').click()
  const navigation = await navigationRoot(page, { openHome: phone })
  const link = navigation.locator(`a[data-nav-route="${state.to}"]`)
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
  await assertHomeNavigationClosed(page, expect)
  await currentPage(page, state.path, expect)
  await expect(page.locator(state.marker)).toBeVisible()
  assertContext(page.url(), state)
  await page.goForward({ waitUntil: 'domcontentloaded' })
  await assertHomeNavigationClosed(page, expect)
  await currentPage(page, state.to, expect)
  await expect(page.locator(state.target)).toBeVisible()
  assertContext(page.url(), state, { path: state.to })
  await openToolbar(page)
  await openUserMenu(page)
  const theme = page.locator('[data-theme-toggle="dark"]:visible').first()
  await theme.click()
  await page.waitForURL(url => url.searchParams.get('theme') === 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  assertContext(page.url(), state, { path: state.to, theme: 'dark' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await openToolbar(page)
  const nextLocale = state.locale === 'en' ? 'ar' : 'en'
  await page.locator('[data-lang-switch]:visible').first().click()
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

async function homeBoundary(page, state, expect, observations) {
  const menu = page.locator('#xpanel-home-menu'), drawer = page.locator('#m-drawer')
  if (state.kind === 'home-sheet-close') {
    await expect(menu).toBeVisible()
    await menu.click()
    await expect(drawer).toBeVisible()
    await drawer.locator('button[data-home-action="close-menu"]').focus()
    await page.setViewportSize({ width: 801, height: 900 })
    await frames(page)
    await expect(menu).toBeHidden()
    await expect(drawer).toBeHidden()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    assert.equal(await page.locator('[data-home-phone] > main').evaluate(element => element.inert), false)
  } else {
    await expect(page.locator('[data-home-desktop]')).toBeVisible()
    await page.locator('#main-content:visible').first().focus()
    await page.keyboard.press('Control+k')
    await expect(page.locator('#xp-cmdk-input')).toBeFocused()
    await page.setViewportSize({ width: 800, height: 900 })
    await frames(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  }
  const focus = await usableFocus(page)
  assert.equal(focus.visible, true, 'The actual Home breakpoint must leave keyboard focus usable')
  await page.keyboard.press('Tab')
  assert.equal((await usableFocus(page)).visible, true)
  observations.push({ check: 'home-boundary-focus', boundary: [800, 801], scenario: state.kind, focus })
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
  observations.push({ check: 'explicit-field-alignment', expected: state.fields.length, measured: values.length, values })
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
  observations.push({ check: 'unqualified-workspace-summary', catalog_qualification_override: false, standalone_summary_dto: true, reachable_authenticated_http_path: false, alignment_measurement: 'nonempty_text_node_ranges_per_line', expected_fields: 5, measured_fields: values.length, values, authorization_proof: false, escaping_proof: 'Exact rendered synthetic text and no script nodes; adversarial escaping belongs to separate renderer tests.' })
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
  await page.locator('#main-content:visible').first().evaluate(element => element.focus({ preventScroll: true }))
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
  const expectedLocalizedRoutes = state.locale === 'ar' ? ['/files/manager'] : ['/files/manager', '/software/php']
  const assertLocalizedResults = async () => {
    await expect(options).toHaveCount(expectedLocalizedRoutes.length)
    const matchedRoutes = await options.evaluateAll(elements => elements.map(element => element.dataset.cmdkItem))
    assert.deepEqual(matchedRoutes, expectedLocalizedRoutes, 'Localized token search must show the exact authorized matches, including existing aliases')
    for (let index = 0; index < expectedLocalizedRoutes.length; index++) {
      const matchedHref = await options.nth(index).getAttribute('href')
      assertContext(new URL(matchedHref, page.url()).href, state, { path: expectedLocalizedRoutes[index] })
    }
    await expect(page.locator('[data-cmdk-status]')).toHaveText(`${state.locale === 'ar' ? 'النتائج' : 'Results'}: ${expectedLocalizedRoutes.length}`)
    return matchedRoutes
  }
  assert.ok(fileIndex >= 8, 'Search must find a real destination beyond the former first-eight truncation')
  await expect(page.locator('[data-cmdk-item="/files/manager"] strong')).toHaveText(label)
  const href = await page.locator('[data-cmdk-item="/files/manager"]').getAttribute('href')
  assertContext(new URL(href, page.url()).href, state, { path: '/files/manager' })
  await input.fill(label)
  const localizedMatches = await assertLocalizedResults()
  await expect(page.locator('[data-cmdk-empty]')).toBeHidden()
  await expect(await selectedPaletteOption(page, expect, 0)).toHaveAttribute('data-cmdk-item', '/files/manager')
  if (state.locale === 'en') {
    await page.keyboard.press('ArrowDown')
    await expect(await selectedPaletteOption(page, expect, 1)).toHaveAttribute('data-cmdk-item', '/software/php')
    await page.keyboard.press('ArrowUp')
    await expect(await selectedPaletteOption(page, expect, 0)).toHaveAttribute('data-cmdk-item', '/files/manager')
  }
  await input.fill('/files/manager')
  await expect(options).toHaveCount(1)
  assert.deepEqual(await options.evaluateAll(elements => elements.map(element => element.dataset.cmdkItem)), ['/files/manager'], 'An exact route query still narrows to one real destination')
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
  await assertLocalizedResults()
  await expect(await selectedPaletteOption(page, expect, 0)).toHaveAttribute('data-cmdk-item', '/files/manager')
  await page.keyboard.press('Enter')
  await page.waitForURL(url => url.pathname === '/files/manager')
  await expect(page.locator('[data-file-manager-table]')).toBeVisible()
  await currentPage(page, '/files/manager', expect)
  assertContext(page.url(), state, { path: '/files/manager' })
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await assertHomeNavigationClosed(page, expect)
  await currentPage(page, state.path, expect)
  assertContext(page.url(), state)
  observations.push({ check: 'palette-localized-filter-and-navigation', destination: '/files/manager', original_index: fileIndex, full_result_count: routes.length, localized_label: label, localized_expected_routes: expectedLocalizedRoutes, localized_observed_routes: localizedMatches, exact_route_query: '/files/manager', exact_route_result_count: 1, second_localized_match_keyboard_selection: state.locale === 'en' ? '/software/php' : null, zero_results: true, clear_recovery: true, arrow_wrap: true, actual_enter_navigation: true, back_context: true })
}

function paletteGeometryLog(outcome) {
  if (!['palette-scroll-ar-1440', 'palette-alias-ar-1440'].includes(outcome.id)) return undefined
  const pick = (value, keys) => value && Object.fromEntries(keys.filter(key => typeof value[key] === 'number' || typeof value[key] === 'string').map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 80) : value[key]]))
  const documentKeys = ['scroll_y', 'document_height', 'body_height', 'client_width', 'viewport_width', 'gutter', 'root_overflow', 'body_overflow', 'active_tag', 'active_id']
  const before = outcome.observations.find(value => value.check === 'palette-scroll-before-close-diagnostics')
  const closed = outcome.observations.find(value => value.check === 'palette-internal-scroll-and-focus-return')
  const alias = outcome.observations.find(value => value.check === 'authorized-alias-search-and-keyboard-navigation')
  return {
    before: pick(before?.scroll_before, documentKeys),
    open: pick(before?.open, ['scroll_top', 'document_y', 'selected_top', 'selected_bottom', 'list_top', 'list_bottom', 'document_width', 'viewport_width']),
    after_escape: pick(closed?.after_diagnostics, documentKeys),
    controls: alias?.controls.slice(0, 3).map(value => ({ ...pick(value, ['role', 'width', 'height']), rect: pick(value.rect, ['x', 'y', 'top', 'right', 'bottom', 'left']), computed: pick(value.computed, ['height', 'min_height', 'box_sizing', 'transform']) })),
    opening_controls: alias?.opening_motion.controls.slice(0, 3).map(value => pick(value, ['width', 'height'])),
    opening_animations: alias?.opening_motion.animations.slice(0, 2).map(value => pick(value, ['play_state', 'duration', 'iterations'])),
    dialog_transform: alias?.dialog_transform?.slice(0, 80),
    animations: alias?.animations.slice(0, 2).map(value => pick(value, ['play_state', 'current_time', 'progress', 'duration'])),
  }
}

function paletteDocumentDiagnostics() {
  const root = document.documentElement, body = document.body, active = document.activeElement
  return { scroll_y: scrollY, document_height: root.scrollHeight, body_height: body.scrollHeight, client_width: root.clientWidth, viewport_width: innerWidth, gutter: innerWidth - root.clientWidth, root_overflow: getComputedStyle(root).overflow, body_overflow: getComputedStyle(body).overflow, active_tag: active?.tagName, active_id: active?.id }
}

async function paletteScroll(page, state, expect, observations, capture) {
  await page.locator('#main-content:visible').first().evaluate(element => element.focus({ preventScroll: true }))
  await page.evaluate(() => scrollTo(0, Math.min(180, Math.max(0, document.documentElement.scrollHeight - innerHeight))))
  await frames(page)
  const beforeDiagnostics = await page.evaluate(paletteDocumentDiagnostics)
  const before = beforeDiagnostics.scroll_y
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
  observations.push({ check: 'palette-scroll-before-close-diagnostics', scroll_before: beforeDiagnostics, open: final })
  assert.ok(final.scroll_top > 100, 'Arrow navigation must scroll the result list')
  assert.ok(final.selected_top >= final.list_top - 1 && final.selected_bottom <= final.list_bottom + 1, 'The selected result must remain inside the list viewport')
  assert.ok(Math.abs(final.document_y - before) <= 1, `Scrolling the result list must preserve the background document position; ${JSON.stringify({ before: beforeDiagnostics, open: final, delta: final.document_y - before })}`)
  assert.ok(final.document_width <= final.viewport_width + 1, 'The palette must fit the actual viewport')
  const routeAlignment = await page.locator(`${paletteOptions}[aria-selected="true"]`).evaluate(option => {
    const title = option.querySelector('strong'), route = option.querySelector('code bdi')
    const ink = element => { const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } }
    const titleInk = ink(title), routeInk = ink(route), rtl = document.documentElement.dir === 'rtl'
    return { kind: option.dataset.cmdkKind, key: option.dataset.cmdkKey, destination: option.dataset.cmdkItem, href: option.getAttribute('href'), persistable: option.dataset.cmdkPersistable, active_scopes: [...document.querySelectorAll('[data-cmdk-scope][aria-pressed="true"]')].map(button => button.dataset.cmdkScope), title: title.textContent.trim(), route: route.textContent.trim(), title_ink: titleInk, route_ink: routeInk, logical_edge_delta: rtl ? Math.abs(titleInk.right - routeInk.right) : Math.abs(titleInk.left - routeInk.left), route_below_title: routeInk.top >= titleInk.bottom, same_line: routeInk.top < titleInk.bottom && titleInk.top < routeInk.bottom, route_direction: route.getAttribute('dir'), wrapper_direction: getComputedStyle(route.parentElement).direction }
  })
  const screenshot = await capture('open-palette')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  await expect(page.locator('#main-content:visible').first()).toBeFocused()
  const afterDiagnostics = await page.evaluate(paletteDocumentDiagnostics)
  observations.push({ check: 'palette-internal-scroll-and-focus-return', result_count: count, scroll_before: before, initial, final, screenshot, escape_return: 'main-content', route_alignment: routeAlignment, before_diagnostics: beforeDiagnostics, after_diagnostics: afterDiagnostics })
  assert.ok(Math.abs(afterDiagnostics.scroll_y - before) <= 1, `Closing the palette must preserve the background document position; ${JSON.stringify({ before: beforeDiagnostics, open: final, after: afterDiagnostics, delta: afterDiagnostics.scroll_y - before })}`)

  assert.ok(['account', 'domain'].includes(routeAlignment.kind), 'ArrowUp must select the final visible authorized record, not assume the final static page')
  assert.deepEqual(routeAlignment.active_scopes, ['all'], 'The final visible record belongs to the current All search scope')
  assert.equal(routeAlignment.persistable, 'false', 'Record destinations must not enter static-route history or favorites')
  const recordDestination = new URL(routeAlignment.href, page.url())
  assert.equal(recordDestination.pathname, routeAlignment.destination)
  assertContext(recordDestination.href, state, { path: routeAlignment.destination })
  if (routeAlignment.kind === 'account') {
    assert.equal(routeAlignment.key, 'account:preview')
    assert.equal(routeAlignment.title, 'preview')
    assert.equal(routeAlignment.route, 'preview.example.test', 'The account result shows its actual public primary domain')
    assert.equal(recordDestination.pathname, '/whm/accounts')
  } else {
    assert.equal(routeAlignment.key, 'domain:preview.example.test:preview')
    assert.equal(routeAlignment.title, 'preview.example.test')
    assert.equal(routeAlignment.route, 'preview', 'The domain result shows its actual public owner username')
    assert.ok(['/whm/domains', '/whm/dns'].includes(recordDestination.pathname), 'The domain result must use an authorized domain destination')
    assert.equal(recordDestination.searchParams.get('domain'), 'preview.example.test')
  }
  assert.equal(routeAlignment.route_direction, 'ltr', 'Technical route content stays isolated LTR')
  assert.ok(routeAlignment.title_ink.width > 0 && routeAlignment.route_ink.width > 0, 'Measure actual nonempty title and route ink')
  if (state.width < 960) {
    assert.equal(routeAlignment.route_below_title, true, 'Compact phone route metadata belongs below its navigation title')
    assert.ok(routeAlignment.logical_edge_delta <= 1, `Phone navigation title and technical route share the logical ink edge; got ${routeAlignment.logical_edge_delta}`)
  } else {
    assert.equal(routeAlignment.same_line, true, 'Desktop palette entries preserve the side-by-side utility row')
  }
}

async function paletteAlias(page, state, expect, observations) {
  await openPalette(page, expect)
  const input = page.locator('[data-cmdk-search]')
  await input.fill('Addon Domains')
  await expect(page.locator(paletteOptions)).toHaveCount(1)
  const selected = await selectedPaletteOption(page, expect, 0)
  await expect(selected).toHaveAttribute('data-cmdk-item', '/domains')
  await expect(selected.locator('strong')).toHaveText(state.locale === 'ar' ? 'النطاقات' : 'Domains')
  await expect(selected.locator('strong')).not.toContainText('Addon Domains')
  await expect(page.locator('[data-cmdk-item^="/whm"]')).toHaveCount(0)
  await expect(page.locator('[data-cmdk-item^="/design/"]')).toHaveCount(0)
  const openingMotion = await page.locator('.xp-cmdk-dialog').evaluate(dialog => ({
    controls: [...dialog.querySelectorAll('[data-cmdk-search],button,[aria-selected="true"]')].slice(0, 3).map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })),
    animations: dialog.getAnimations().map(animation => ({ play_state: animation.playState, duration: animation.effect?.getComputedTiming().duration, iterations: animation.effect?.getTiming().iterations })),
  }))
  assert.ok(openingMotion.animations.every(animation => Number.isFinite(animation.duration) && Number.isFinite(animation.iterations)), 'Palette opening geometry requires finite presentation animations')
  observations.push({ check: 'palette-opening-motion-before-steady-geometry', ...openingMotion })
  await expect.poll(() => page.locator('.xp-cmdk-dialog').evaluate(dialog => dialog.getAnimations().every(animation => animation.playState === 'finished' || animation.playState === 'idle')), { timeout: 8000 }).toBe(true)
  await frames(page)
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('.xp-cmdk-dialog')
    const header = dialog.firstElementChild
    const title = document.querySelector('#xp-cmdk-title')
    const close = header.querySelector('button')
    const input = document.querySelector('[data-cmdk-search]')
    const list = document.querySelector('[data-cmdk-results]')
    const option = list.querySelector('[aria-selected="true"]')
    const footer = dialog.querySelector(':scope > .xp-cmdk-footer')
    const bounds = element => element.getBoundingClientRect()
    const card = bounds(dialog), h = bounds(title), c = bounds(close), q = bounds(input), result = bounds(option), footerBounds = bounds(footer)
    const groups = [...dialog.children].filter(element => element.checkVisibility({ checkVisibilityCSS: true }) && !element.hidden && bounds(element).width > 0 && bounds(element).height > 0)
    const groupName = element => element.classList.contains('xp-cmdk-header') ? 'header' : element.classList.contains('xp-cmdk-search') ? 'query' : element.classList.contains('xp-cmdk-scopes') ? 'scopes' : element.hasAttribute('data-cmdk-history') ? 'history' : element.hasAttribute('data-cmdk-results') ? 'results' : element.hasAttribute('data-cmdk-empty') ? 'empty' : element.classList.contains('xp-cmdk-footer') ? 'footer' : 'unexpected'
    const utilityControls = [input, close, option, ...dialog.querySelectorAll('[data-cmdk-scope]')]
    const border = getComputedStyle(dialog)
    const inner = { top: card.top + parseFloat(border.borderTopWidth), right: card.right - parseFloat(border.borderRightWidth), bottom: card.bottom - parseFloat(border.borderBottomWidth), left: card.left + parseFloat(border.borderLeftWidth) }
    const ink = document.createRange(); ink.selectNodeContents(title)
    const heading = ink.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    return {
      panel_padding: { top: Math.min(h.top, c.top) - inner.top, right: inner.right - q.right, bottom: inner.bottom - footerBounds.bottom, left: q.left - inner.left },
      heading_query_group_gap: q.top - Math.max(h.bottom, c.bottom),
      semantic_groups: groups.map(groupName),
      sibling_group_gaps: groups.slice(1).map((element, index) => ({ from: groupName(groups[index]), to: groupName(element), gap: bounds(element).top - bounds(groups[index]).bottom })),
      footer_is_last_content: groups.at(-1) === footer,
      heading_control_edge_delta: rtl ? Math.abs(heading.right - q.right) : Math.abs(heading.left - q.left),
      controls: utilityControls.map((element, index) => {
        const rect = bounds(element), style = getComputedStyle(element)
        return { role: ['input', 'close', 'option'][index] ?? 'scope:' + element.dataset.cmdkScope, width: rect.width, height: rect.height, rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }, computed: { height: style.height, min_height: style.minHeight, box_sizing: style.boxSizing, transform: style.transform } }
      }),
      dialog_transform: border.transform,
      animations: document.querySelector('[data-xp-cmdk]').getAnimations({ subtree: true }).map(animation => {
        const timing = animation.effect?.getComputedTiming()
        return { play_state: animation.playState, current_time: animation.currentTime, progress: timing?.progress, duration: timing?.duration }
      }),
      query_visible_label: [...document.querySelectorAll('label[for="xp-cmdk-input"]')].some(label => !label.classList.contains('xp-sr-only')),
      technical_route_direction: option.querySelector('code bdi')?.getAttribute('dir'),
      result_list_role: list.getAttribute('role'),
      utility_rows_are_not_cards: true,
      not_applicable: ['No visible label/value pair is invented for the accessible combobox.', 'Compact option rows are utility controls, not content cards or sibling form fields.', 'This command menu has no separate major content section.'],
    }
  })
  const href = await selected.getAttribute('href')
  assertContext(new URL(href, page.url()).href, state, { path: '/domains' })
  await page.keyboard.press('Enter')
  await page.waitForURL(url => url.pathname === '/domains')
  await expect(page.locator('[data-domains-table]')).toBeVisible()
  await currentPage(page, '/domains', expect)
  assertContext(page.url(), state, { path: '/domains' })
  observations.push({ check: 'authorized-alias-search-and-keyboard-navigation', alias: 'Addon Domains', destination: '/domains', visible_label_unchanged: true, actual_enter_navigation: true, opening_motion: openingMotion, ...geometry })
  const expectedPadding = state.width < 960 ? 16 : 24
  for (const [edge, value] of Object.entries(geometry.panel_padding)) assert.ok(Math.abs(value - expectedPadding) <= 1, `Actual palette content ${edge} padding must be ${expectedPadding}px; got ${value}`)
  assert.ok(Math.abs(geometry.heading_query_group_gap - 24) <= 1, 'The header and query are sibling groups with 24px spacing')
  assert.equal(geometry.footer_is_last_content, true, 'Actual card padding must end after the retained footer')
  assert.deepEqual(geometry.semantic_groups.filter(group => ['header', 'query', 'scopes', 'results', 'footer'].includes(group)), ['header', 'query', 'scopes', 'results', 'footer'], 'The current header, query, scope tabs, results and footer remain present in semantic order')
  assert.ok(geometry.semantic_groups.every(group => ['header', 'query', 'scopes', 'history', 'results', 'footer'].includes(group)), 'Visible history is measured as its own group and no current group is hidden to pass spacing')
  assert.ok(geometry.sibling_group_gaps.length >= 4)
  for (const gap of geometry.sibling_group_gaps) assert.ok(Math.abs(gap.gap - 24) <= 1, 'Actual palette sibling groups ' + gap.from + ' to ' + gap.to + ' must be 24px apart; got ' + gap.gap)
  assert.deepEqual(geometry.controls.filter(control => control.role.startsWith('scope:')).map(control => control.role), ['scope:all', 'scope:action', 'scope:account', 'scope:domain'], 'All four current search scopes retain measured controls')
  assert.ok(geometry.heading_control_edge_delta <= 1, 'The visible heading and query control share the logical content edge')
  for (const control of geometry.controls) assert.ok(control.width >= 44 && control.height >= 44, `Actual palette controls retain 44px targets; ${JSON.stringify({ control, all_controls: geometry.controls, dialog_transform: geometry.dialog_transform, animations: geometry.animations })}`)
  assert.equal(geometry.technical_route_direction, 'ltr')
  assert.equal(geometry.result_list_role, 'listbox')
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
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(body).toHaveAttribute('role', 'textbox')
  await expect(body).toHaveAttribute('aria-multiline', 'true')
  await body.fill('Native textarea')
  await page.keyboard.type('/ga')
  await expect(body).toHaveText('Native textarea/ga')
  await expect(body).toBeFocused()
  assertContext(page.url(), state)
  await page.locator('#main-content:visible').first().evaluate(element => element.focus({ preventScroll: true }))
  await page.keyboard.press('/')
  const search = page.locator(':is([data-xp-filter-input],input[type="search"]):visible').first()
  await expect(search).toBeFocused()
  await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  await page.keyboard.type('/')
  await expect(search).toHaveValue('/')
  assertContext(page.url(), state)
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-cmdk-search]')).toBeFocused()
  await page.keyboard.type('/')
  await expect(page.locator('[data-cmdk-search]')).toHaveValue('/')
  await page.keyboard.press('Escape')
  await expect(search).toBeFocused()
  observations.push({ check: 'native-slash-and-chord-text-preserved', controls: ['compose-subject', 'compose-body'], message_body_control: 'native-contenteditable-textbox', text_values: ['Native input/gd', 'Native textarea/ga'], visible_mail_search_slash_preserved: true, palette_query_slash_preserved: true })
}

async function paletteVisibility(page, state, expect, observations) {
  if (state.kind === 'palette-unqualified') {
    await expect(page.locator('[data-xp-cmdk],[data-action="open-cmdk"],[data-cmdk-item]')).toHaveCount(0)
    await expect(page.locator('[data-xp-sidebar] a[data-nav-route]')).not.toHaveCount(0)
    await page.locator('#main-content:visible').first().focus()
    for (const key of ['Control+k', '/', 'g', 'a', 'g', 'f']) await page.keyboard.press(key)
    assertContext(page.url(), state)
    await expect(page.locator('[data-xp-cmdk],[data-cmdk-item]')).toHaveCount(0)
    observations.push({ check: 'unqualified-palette-absence', synthetic_original_catalog: true, standalone_summary_dto: true, reachable_authenticated_http_path: false, palette_count: 0, enabled_shortcut_destinations: 0, production_authorization_proof: false })
    return
  }
  await openPalette(page, expect)
  const actual = await page.locator('[data-cmdk-item]').evaluateAll(elements => elements.map(element => element.dataset.cmdkItem).sort())
  const sidebar = await page.locator('[data-xp-sidebar] a[data-nav-route]').evaluateAll(elements => elements.map(element => element.dataset.navRoute).sort())
  assert.ok(actual.length > 8)
  assert.ok(sidebar.includes('/home') && !sidebar.includes('/design/system') && !sidebar.includes('/design/components') && !sidebar.includes('/design/navigation'), 'Product navigation omits the design specimen routes')
  assert.ok(actual.every(path => !path.startsWith('/design/')), 'The command palette must omit design specimen routes')
  assert.ok(actual.every(path => path !== '/whm' && !path.startsWith('/whm/')), 'The account-owner palette must omit administrator destinations')
  await page.locator('[data-cmdk-search]').fill('/whm')
  await expect(page.locator(paletteOptions)).toHaveCount(0)
  await expect(page.locator('[data-cmdk-empty]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#main-content:visible').first()).toBeFocused()
  observations.push({ check: 'synthetic-owner-palette-visibility', owner_result_count: actual.length, navigation_routes_observed: sidebar.length, palette_omits_admin_and_design_routes: true, enabled_admin_destinations: 0, production_authorization_proof: false })
}

async function contextualShortcuts(page, state, expect, observations) {
  const checks = state.surface === 'panel' ? [['f', '/files/manager'], ['d', '/home'], ['a', '/home']]
    : state.surface === 'whm' ? [['a', '/whm/accounts'], ['d', '/whm'], ['f', '/whm']]
    : [['d', '/mail/inbox'], ['a', '/mail/inbox'], ['f', '/mail/inbox']]
  const completed = []
  for (const [key, path] of checks) {
    const before = page.url()
    await page.locator('#main-content:visible').first().evaluate(element => element.focus({ preventScroll: true }))
    await page.keyboard.press('g')
    await page.keyboard.press(key)
    if (new URL(before).pathname !== path) await page.waitForURL(url => url.pathname === path)
    assertContext(page.url(), state, { path })
    await currentPage(page, path, expect)
    completed.push({ chord: `g ${key}`, path, navigated: before !== page.url() })
  }
  observations.push({ check: 'contextual-chord-shortcuts', surface: state.surface, checks: completed })
}

export async function measureAuditGeometry(page) {
  const metrics = await page.evaluate(() => {
    const section = document.querySelector('[data-section="audit-log"]')
    const rect = element => { if (!element) throw new Error('A required audit geometry element is missing'); return element.getBoundingClientRect() }
    const visible = element => { const r = rect(element); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden]') }
    const glyph = element => {
      if (!element) return null
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), boxes = []
      let node
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue
        const range = document.createRange(); range.selectNodeContents(node)
        boxes.push(...[...range.getClientRects()].filter(box => box.width > 0 && box.height > 0))
      }
      return boxes.length ? { left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)), top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) } : null
    }
    const between = (first, second) => {
      const a = rect(first), b = rect(second)
      return Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1 ? Math.max(b.left - a.right, a.left - b.right) : b.top - a.bottom
    }
    const siblingGaps = nodes => {
      const rows = []
      for (const node of nodes) {
        const top = rect(node).top, row = rows.find(row => Math.abs(row.top - top) <= 1)
        if (row) row.nodes.push(node)
        else rows.push({ top, nodes: [node] })
      }
      return rows.flatMap((row, index) => [
        ...row.nodes.slice(1).map((node, previous) => between(row.nodes[previous], node)),
        ...(index ? [Math.min(...row.nodes.map(node => rect(node).top)) - Math.max(...rows[index - 1].nodes.map(node => rect(node).bottom))] : []),
      ])
    }
    const rtl = document.dir === 'rtl', card = rect(section), style = getComputedStyle(section)
    const header = rect(section.querySelector(':scope > .xp-card__header')), formElement = section.querySelector('[data-audit-filters]')
    const form = rect(formElement), tableElement = section.querySelector(':scope > .xp-table-wrap'), table = rect(tableElement)
    const supplement = section.querySelector(':scope > [data-audit-supplement]')
    const content = [...section.children].filter(visible), lastContent = rect(content.at(-1))
    const fields = [...formElement.querySelectorAll('.xp-field')]
    const controlFor = field => {
      const controls = field.querySelectorAll('input:not([type="hidden"]),select,textarea')
      if (controls.length !== 1) throw new Error('Each audit field must expose exactly one real input or select')
      return controls[0]
    }
    const submit = rect(formElement.querySelector('button[type="submit"]'))
    const fieldParents = [...new Set(fields.map(field => field.parentElement))]
    const fieldGaps = fieldParents.flatMap(parent => siblingGaps(fields.filter(field => field.parentElement === parent)))
    for (const parent of fieldParents.filter(parent => parent !== formElement)) {
      const previous = [...formElement.children].filter(visible).filter(child => child.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)
      if (previous) fieldGaps.push(between(previous, parent))
    }
    const actions = [...formElement.querySelectorAll('a[data-audit-clear],button[type="submit"]')]
    const majorSupplementGaps = supplement ? [
      ...siblingGaps([...supplement.children].filter(visible)),
      ...[...supplement.querySelectorAll(':scope > .xp-whm-detail-column')].flatMap(column => siblingGaps([...column.children].filter(visible))),
    ] : []
    const border = { top: parseFloat(style.borderTopWidth), right: parseFloat(style.borderRightWidth), bottom: parseFloat(style.borderBottomWidth), left: parseFloat(style.borderLeftWidth) }
    const pagerGroups = [...section.querySelectorAll(':scope > [data-audit-pager],:scope > .xp-btn-group')]
    const pagerLinks = pagerGroups.flatMap(group => [...group.querySelectorAll('a[href]')])
    const values = [...tableElement.querySelectorAll('tbody .xp-audit-value')]
    const mobileFields = values.map(value => {
      const label = value.parentElement.querySelector('.xp-audit-mobile-label'), badge = value.querySelector('.xp-badge')
      const labelGlyph = glyph(label), valueGlyph = badge ? rect(badge) : glyph(value)
      return { label_visible: getComputedStyle(label).display !== 'none', value_nonempty: !!value.textContent.trim(), value_kind: badge ? 'painted_badge_box' : 'actual_text_node_range', gap: rect(value).top - rect(label).bottom, edge_delta: labelGlyph && valueGlyph ? Math.abs(rtl ? labelGlyph.right - valueGlyph.right : labelGlyph.left - valueGlyph.left) : null, value_below_label: !labelGlyph || !valueGlyph || valueGlyph.top >= labelGlyph.bottom + 7 }
    })
    const headers = [...tableElement.querySelectorAll('thead th')], rows = [...tableElement.querySelectorAll('tbody tr')]
    const desktopColumns = headers.map((th, index) => {
      const value = rows.map(row => row.cells[index]?.querySelector('.xp-audit-value')).find(element => element?.textContent.trim())
      const badge = value?.querySelector('.xp-badge'), labelGlyph = glyph(th), content = badge ? rect(badge) : glyph(value)
      const box = rect(th)
      return { column: index, header_visible: box.width > 0 && box.height > 0 && !!labelGlyph, value_nonempty: !!value, value_kind: badge ? 'painted_badge_box' : 'actual_text_node_range', edge_delta: labelGlyph && content ? Math.abs(rtl ? labelGlyph.right - content.right : labelGlyph.left - content.left) : null }
    })
    const technicalColumns = [0, 1, 3].map(index => {
      const value = rows.map(row => row.cells[index]?.querySelector('.xp-audit-value')).find(element => element?.textContent.trim())
      const tokens = [...(value?.querySelectorAll('bdi[dir="ltr"]') ?? [])].filter(token => token.textContent.trim())
      return { column: index, tokens: tokens.length, isolated: tokens.length > 0 && tokens.every(token => getComputedStyle(token).direction === 'ltr' && getComputedStyle(token).unicodeBidi.includes('isolate')) }
    })
    return {
      viewport: innerWidth, direction: document.dir, document_width: document.documentElement.scrollWidth,
      padding: { top: header.top - card.top - border.top, bottom: card.bottom - lastContent.bottom - border.bottom, inline_start: rtl ? card.right - border.right - form.right : form.left - card.left - border.left, inline_end: rtl ? form.left - card.left - border.left : card.right - border.right - form.right },
      content_last_kind: content.at(-1).hasAttribute('data-audit-supplement') ? 'audit-supplement' : content.at(-1).tagName,
      title_to_form: form.top - header.bottom, form_to_table: table.top - form.bottom,
      table_to_supplement: supplement ? rect(supplement).top - table.bottom : null, supplement_major_gaps: majorSupplementGaps,
      field_ids: fields.map(field => controlFor(field).id),
      label_to_input: fields.map(field => rect(controlFor(field)).top - rect(field.querySelector('label')).bottom),
      field_siblings: fieldGaps,
      label_control_outer_edges: fields.map(field => { const label = rect(field.querySelector('label')), control = rect(controlFor(field)); return Math.abs(rtl ? label.right - control.right : label.left - control.left) }),
      select_alignment: fields.flatMap(field => {
        const control = controlFor(field)
        if (control.tagName !== 'SELECT') return []
        const label = glyph(field.querySelector('label')), box = rect(control)
        if (!label) throw new Error('The actual select label text must be visible')
        return [{ id: control.id, label_edge: rtl ? label.right : label.left, selected_text: control.selectedOptions[0]?.textContent.trim() ?? '', control_visible: visible(control), control_rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, edge_basis: 'pending-native-select-text-range' }]
      }),
      label_input_edges: fields.map(field => { const label = glyph(field.querySelector('label')), control = rect(controlFor(field)); return label ? Math.abs(rtl ? label.right - control.right : label.left - control.left) : null }),
      last_field_to_submit: fields.length ? submit.top - rect(fields.at(-1)).bottom : null, action_siblings: siblingGaps(actions),
      controls: [...formElement.querySelectorAll('input:not([type="hidden"]),select,button[type="submit"],a[data-audit-clear]')].map(control => ({ id: control.id || (control.hasAttribute('data-audit-clear') ? 'filter-clear' : 'filter-submit'), tag: control.tagName, width: rect(control).width, height: rect(control).height })),
      pager_groups: pagerGroups.length, pager_links: pagerLinks.length, empty_pager_groups: pagerGroups.filter(group => !group.querySelector('a[href]')).length,
      record_sibling_gaps: rows.flatMap(row => [...row.cells].slice(1).map((cell, index) => rect(cell).top - rect(row.cells[index]).bottom)),
      record_padding: rows.filter(row => row.querySelector('.xp-audit-value')).map(row => {
        const outer = rect(row), first = rect(row.cells[0]), last = rect(row.cells[row.cells.length - 1]), border = getComputedStyle(row)
        return { top: first.top - outer.top - parseFloat(border.borderTopWidth), bottom: outer.bottom - last.bottom - parseFloat(border.borderBottomWidth), inline_start: rtl ? outer.right - parseFloat(border.borderRightWidth) - first.right : first.left - outer.left - parseFloat(border.borderLeftWidth), inline_end: rtl ? first.left - outer.left - parseFloat(border.borderLeftWidth) : outer.right - parseFloat(border.borderRightWidth) - first.right }
      }),
      mobile_fields: mobileFields, desktop_columns: desktopColumns, technical_columns: technicalColumns,
    }
  })
  if (metrics.select_alignment.length) {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      const find = (node, id) => node.nodeName === 'SELECT' && node.attributes?.some((value, index, attrs) => value === 'id' && attrs[index + 1] === id) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(child => find(child, id)).find(Boolean)
      for (const value of metrics.select_alignment) {
        assert.equal(value.control_visible, true, 'The actual audit select must be visible')
        assert.ok(value.selected_text.length > 0, 'The actual selected audit option must have visible text')
        const select = find(root, value.id)
        const inner = select?.shadowRoots?.flatMap(node => node.children ?? []).find(node => node.attributes?.includes('-internal-select-inner-element'))
        assert.ok(inner, 'The actual native audit SELECT value element must be observable')
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: inner.backendNodeId })
        const measured = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { const range = document.createRange(); range.selectNodeContents(this); const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, text: this.textContent } }', returnByValue: true })
        assert.ok(!measured.exceptionDetails && measured.result.value?.width > 0 && measured.result.value.height > 0, 'Measure the actual nonempty native selected text Range, never a mirrored field')
        value.rendered_value = measured.result.value
        assert.equal(value.rendered_value.text.trim(), value.selected_text, 'The measured native text must match the actual selected option')
        assert.ok(value.rendered_value.left >= value.control_rect.left - 1 && value.rendered_value.right <= value.control_rect.right + 1 && value.rendered_value.top >= value.control_rect.top - 1 && value.rendered_value.bottom <= value.control_rect.bottom + 1, 'The selected value must be painted inside its visible select control')
        value.value_edge = metrics.direction === 'rtl' ? value.rendered_value.right : value.rendered_value.left
        value.edge_basis = 'actual-native-select-text-range'
        value.edge_delta = Math.abs(value.label_edge - value.value_edge)
        const index = metrics.field_ids.indexOf(value.id)
        assert.ok(index >= 0)
        metrics.label_input_edges[index] = value.edge_delta
      }
    } finally { await cdp.detach() }
  }
  return metrics
}

export function assertAuditGeometry(metrics, state) {
  const expectedPadding = state.width <= 640 ? 16 : 24
  assert.equal(metrics.viewport, state.width)
  assert.ok(metrics.document_width <= metrics.viewport + 1, 'Audit geometry must fit without horizontal overflow')
  assert.equal(metrics.title_to_form, 24, 'Audit heading and filter form must have a 24px group gap')
  assert.equal(metrics.form_to_table, 24, 'Audit filters and table must have a 24px group gap')
  assert.deepEqual(metrics.field_ids, ['audit-actor', 'audit-action', 'audit-target', 'audit-outcome', 'audit-from', 'audit-to'], 'All six current audit inputs/selects must be measured')
  assert.deepEqual(metrics.label_to_input, [8, 8, 8, 8, 8, 8], 'Each real filter input/select must sit 8px below its label')
  assert.deepEqual(metrics.field_siblings, [16, 16, 16, 16, 16], 'All adjacent filter fields retain 16px gaps across their actual parent/grid hierarchy')
  assert.equal(metrics.last_field_to_submit, 16, 'The action group must remain 16px after the last field')
  assert.deepEqual(metrics.action_siblings, [16], 'Clear and Apply retain the 16px sibling-control gap')
  assert.deepEqual(metrics.label_control_outer_edges, [0, 0, 0, 0, 0, 0], 'All filter labels and control borders retain the separate outer grid invariant')
  assert.equal(metrics.label_input_edges.length, 6)
  assert.equal(metrics.select_alignment.length, 1)
  assert.deepEqual(metrics.label_input_edges.filter((_delta, index) => !metrics.select_alignment.some(value => value.id === metrics.field_ids[index])), [0, 0, 0, 0, 0], 'Unchanged bare input fields retain their existing label/control alignment')
  for (const value of metrics.select_alignment) {
    assert.equal(value.control_visible, true)
    assert.equal(value.edge_basis, 'actual-native-select-text-range')
    assert.ok(value.selected_text.length > 0 && value.rendered_value.width > 0 && value.rendered_value.height > 0, 'The actual selected value remains nonempty and painted')
    assert.equal(value.rendered_value.text.trim(), value.selected_text)
    assert.ok(value.edge_delta <= 1, 'The select label glyphs and actual selected value text share the logical content edge')
  }
  assert.equal(metrics.controls.length, 8)
  assert.equal(metrics.controls.filter(control => control.tag === 'SELECT').length, 1, 'Outcome is a real select, not an absent input')
  for (const control of metrics.controls) assert.ok(control.width >= 44 && control.height >= 44, 'Audit control ' + control.id + ' must retain a 44px target')
  assert.equal(metrics.pager_links, 0, 'This fixture has no earlier or older audit-page links')
  assert.equal(metrics.empty_pager_groups, 0, 'A no-links audit page must not render an empty pagination group')
  assert.equal(metrics.pager_groups, 0, 'The no-links fixture must not invent a pagination group')
  assert.equal(metrics.content_last_kind, 'audit-supplement', 'The current card includes the authorized detail/generation supplement after its table')
  assert.equal(metrics.table_to_supplement, 24, 'The table and its detail supplement retain the 24px sibling-group gap')
  assert.ok(metrics.supplement_major_gaps.length > 0 && metrics.supplement_major_gaps.every(gap => gap === 32), 'Actual supplementary major sections retain 32px spacing')
  for (const [edge, gap] of Object.entries(metrics.padding)) assert.equal(gap, expectedPadding, 'The actual audit card ' + edge + ' padding must be ' + expectedPadding + 'px')
  assert.equal(metrics.desktop_columns.length, 5)
  assert.equal(metrics.technical_columns.length, 3)
  assert.ok(metrics.technical_columns.every(column => column.isolated), 'Actual date, actor and target values must retain LTR isolation')
  if (state.width <= 390) {
    assert.equal(metrics.record_sibling_gaps.length, 4)
    assert.ok(metrics.record_sibling_gaps.every(gap => gap === 16), 'Real mobile audit fields must retain 16px sibling gaps')
    assert.equal(metrics.record_padding.length, 1)
    for (const padding of metrics.record_padding) for (const gap of Object.values(padding)) assert.equal(gap, 16, 'Actual mobile record padding must be 16px on every edge')
    assert.equal(metrics.mobile_fields.length, 5)
    for (const field of metrics.mobile_fields) {
      assert.equal(field.label_visible, true)
      assert.equal(field.gap, 8, 'A mobile audit value must sit 8px below its real label')
      assert.equal(field.value_below_label, true)
      if (field.value_nonempty) assert.ok(field.edge_delta <= 1, 'Mobile label and painted audit value must share the logical edge')
    }
  } else {
    for (const column of metrics.desktop_columns) {
      assert.equal(column.header_visible, true)
      assert.equal(column.value_nonempty, true)
      assert.ok(column.edge_delta <= 1, 'Audit column ' + column.column + ' header glyphs and actual painted cell content must share their logical edge')
    }
  }
}

async function auditSpacing(page, state, expect, observations) {
  await expect(page.locator('[data-section="audit-log"]')).toBeVisible()
  const metrics = await measureAuditGeometry(page)
  observations.push({ check: 'actual-audit-filter-table-spacing', metrics, pagination_scope: 'No-links fixture with six filters, Clear/Apply and the current detail supplement; real older/newest links remain covered by renderer tests.' })
  assertAuditGeometry(metrics, state)
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
  const unqualifiedFixture = await createVisualFixture({ qualifiedCatalog: false, resolvedAccount: false })
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 20000 })
  const outcomes = []
  let started = Date.now(), fontTransport = null, preparationFailure = null
  try {
    fontTransport = await prepareNavigationFontTransport(browser, fixture, unqualifiedFixture)
    started = Date.now()
    for (const state of selected) {
      const outcome = { ...state, status: 'running', observations: [], page_errors: [], console_errors: [], mutations: [], websockets: [], font_transport_errors: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: state.height ?? (state.width < 960 ? 800 : 900) }, colorScheme: 'light', reducedMotion: state.kind === 'motion' ? 'reduce' : 'no-preference' })
      const page = await context.newPage()
      const networkDiagnostics = failureNetworkDiagnostics(page)
      page.setDefaultTimeout(8000)
      await context.route('**/*', async route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) { outcome.mutations.push({ method: route.request().method() }); await route.abort(); return }
        if (await fontTransport.replay(route, outcome.font_transport_errors)) return
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
        else if (state.kind === 'audit-spacing') await auditSpacing(page, state, expect, outcome.observations)
        else if (state.kind === 'summary') await summary(page, state, expect, outcome.observations)
        else if (state.kind === 'palette-filter') await paletteFilter(page, state, expect, outcome.observations)
        else if (state.kind === 'palette-alias') await paletteAlias(page, state, expect, outcome.observations)
        else if (state.kind === 'palette-scroll') await paletteScroll(page, state, expect, outcome.observations, async suffix => {
          const screenshot = `screenshots/${state.id}-${suffix}.png`
          await page.screenshot({ path: join(destination, screenshot), fullPage: true })
          return screenshot
        })
        else if (state.kind === 'palette-native-input') await paletteNativeInput(page, state, expect, outcome.observations)
        else if (['palette-owner', 'palette-unqualified'].includes(state.kind)) await paletteVisibility(page, state, expect, outcome.observations)
        else if (state.kind === 'shortcut-context') await contextualShortcuts(page, state, expect, outcome.observations)
        else if (state.kind === 'shortcut') {
          await page.locator('#main-content:visible').first().focus()
          await page.keyboard.press('/')
          const filter = page.locator(':is([data-xp-filter-input],input[type="search"]):visible').first()
          await expect(filter).toBeFocused()
          await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
          await page.keyboard.type('/gd')
          await expect(filter).toHaveValue('/gd')
          assertContext(page.url(), state)
          await page.keyboard.press('Control+k')
          await expect(page.locator('#xp-cmdk-input')).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
          await expect(filter).toBeFocused()
          outcome.observations.push({ check: 'slash-search', destination: 'visible-filter', native_typing_preserved: true, command_palette_keyboard_access: true })
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
          const motion = await page.evaluate(() => ({ preference: matchMedia('(prefers-reduced-motion: reduce)').matches, transitions: [...document.querySelectorAll('#m-drawer,#xpanel-home-drawer-host > div > button[data-home-action="close-menu"]')].map(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationDuration })) }))
          assert.equal(motion.preference, true)
          assert.equal(motion.transitions.length, 2)
          for (const values of motion.transitions) for (const duration of [values.transition, values.animation]) assert.ok(duration.split(',').every(value => Number.parseFloat(value) <= 0.001), 'Reduced motion must remove sheet/backdrop movement')
          outcome.observations.push({ check: 'reduced-motion', ...motion })
        } else if (state.kind.startsWith('home-')) await homeBoundary(page, state, expect, outcome.observations)
        else await boundary(page, state, expect, outcome.observations)
        const unexpected = outcome.console_errors.filter(error => !/fonts\.(?:googleapis|gstatic)\.com/.test(`${error.url} ${error.text}`) && !/\/api\/auth\/me(?:\?|$)/.test(error.url) && !(state.kind === 'unavailable' && /\/no-such-navigation-document$/.test(error.url)))
        assert.deepEqual(unexpected, [], 'No unexpected application console errors')
        assert.deepEqual(outcome.page_errors, [])
        assert.deepEqual(outcome.mutations, [])
        assert.deepEqual(outcome.websockets, [])
        assert.deepEqual(outcome.font_transport_errors, [])
        outcome.status = 'passed'
      } catch (error) {
        outcome.status = 'failed'
        outcome.failure = { name: error.name, message: String(error.message).slice(0, 1000), stack: String(error.stack).split('\n').slice(0, 10) }
        outcome.network_failure = networkDiagnostics.snapshot()
      } finally {
        outcome.screenshot = `screenshots/${state.id}.png`
        await page.screenshot({ path: join(destination, outcome.screenshot), fullPage: true }).catch(error => { outcome.screenshot_error = String(error.message).slice(0, 200) })
        await context.close()
        outcomes.push(outcome)
        process.stdout.write(`${JSON.stringify({ id: state.id, status: outcome.status, failure: outcome.failure?.message, geometry: paletteGeometryLog(outcome) })}\n`)
      }
    }
  } catch (error) {
    if (fontTransport) throw error
    preparationFailure = { code: error.fontCode ?? 'font-preparation-failed', preparation: error.preparation ?? null }
  } finally { await browser.close(); await fixture.close(); await unqualifiedFixture.close() }
  const after = fingerprint(destination, 'after'), initial = new Map(before.files.map(file => [file.path, file.sha256])), final = new Map(after.files.map(file => [file.path, file.sha256]))
  const drift = [...new Set([...initial.keys(), ...final.keys()])].filter(path => initial.get(path) !== final.get(path)).sort()
  const actions = outcomes.flatMap(outcome => outcome.observations.flatMap(observation => observation.check === 'mobile-overlay' ? [observation.opening, observation.closing] : []))
  const times = actions.map(action => action.event_to_second_frame_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const observations = outcomes.flatMap(outcome => outcome.observations)
  const measurements = { local_input_events: times.length, event_to_second_frame_ms: { minimum: times[0] ?? null, median: times.length ? times[Math.floor(times.length / 2)] : null, p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null, maximum: times.at(-1) ?? null }, observed_layout_shift_entries: actions.reduce((sum, action) => sum + action.shifts.length, 0), layout_shift_value_sum_including_recent_input: actions.reduce((sum, action) => sum + action.shifts.reduce((total, shift) => total + shift.value, 0), 0), fonts_ready: outcomes.filter(outcome => outcome.fonts?.ready).length, actual_locale_font_verified: outcomes.filter(outcome => outcome.fonts?.applied_ui?.rendered_glyphs > 0).length, actual_downloadable_locale_font_loaded: outcomes.filter(outcome => outcome.fonts?.family !== 'sans-serif' && outcome.fonts?.faces.some(face => face.family === outcome.fonts.family && face.status === 'loaded')).length, explicit_control_fields: observations.filter(value => value.check === 'explicit-field-alignment').reduce((sum, value) => sum + value.measured, 0), workspace_summary_fields: observations.filter(value => value.check === 'unqualified-workspace-summary').reduce((sum, value) => sum + value.measured_fields, 0) }
  const report = { schema_version: 1, captured_at: new Date().toISOString(), status: preparationFailure ? 'blocked' : outcomes.length === selected.length && outcomes.every(outcome => outcome.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', font_transport: fontTransport?.report() ?? preparationFailure?.preparation ?? null, prerequisite_failure: preparationFailure, runtime: process.version, environment: { platform: process.platform, browser: browser.version(), headless: true, loopback: true, cpu_throttling: 'none', network_throttling: 'none', external_fonts: true, viewport_emulation_only: true, physical_touch_device: false }, scope: { filter: filter ?? null, full_suite_case_count: states.length, requested_case_count: selected.length, executed_case_count: outcomes.length, initial_widths: [...new Set(selected.map(state => state.width))].sort((a, b) => a - b), initial_heights: [...new Set(selected.map(state => state.height ?? (state.width < 960 ? 800 : 900)))].sort((a, b) => a - b), boundary_widths: [...new Set(selected.flatMap(state => state.kind.startsWith('home-') ? [800, 801] : ['sheet-close', 'toolbar-summary', 'palette-return'].includes(state.kind) ? [959, 960] : []))].sort((a, b) => a - b), locales: [...new Set(selected.map(state => state.locale))], qualified_catalog_test_states: selected.filter(state => !['summary', 'palette-unqualified'].includes(state.kind)).length, original_unqualified_catalog_states: selected.filter(state => ['summary', 'palette-unqualified'].includes(state.kind)).length }, tests: { total: outcomes.length, passed: outcomes.filter(outcome => outcome.status === 'passed').length, failed: outcomes.filter(outcome => outcome.status === 'failed').length }, measurements, duration_ms: preparationFailure ? 0 : Date.now() - started, source: { before_sha256: before.sha256, after_sha256: after.sha256, files: before.files.length, drift }, limits: ['Synthetic catalog and principals are test-only; no authentication, authorization enforcement, host command, hosting service or production qualification.', 'Theme persistence means selected URL context survives document navigation and reload; this suite does not require a browser storage preference absent from the product contract.', 'Input-event-to-second-frame measurements use browser performance.now and requestAnimationFrame. Action-to-second-frame durations also include automation dispatch. Neither is INP. Layout-shift entries include recent-input flags and are not a page CLS qualification.', 'Sampled shell routes, explicit field contracts, two locales and selected breakpoints do not certify every screen or accessibility requirement.', 'Font bytes are freshly prepared over bounded HTTPS and replayed unchanged; case timings qualify ready-font interaction and geometry, not cold CDN latency, availability or offline production.', 'The account Home filter is exercised directly: slash focuses the visible existing search/filter input and preserves native typing. Command-palette access remains separately exercised through its shared keyboard shortcut. The unresolved-account cases exercise only the standalone synthetic summary DTO renderer; real authenticated missing-account HTTP requests remain denied.'], outcomes }
  writeFileSync(join(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(destination, 'README.md'), `# Synthetic navigation acceptance\n\n${report.tests.passed}/${report.tests.total} cases passed; source drift: ${drift.length}.\n\nSee [results](results.json). Font faces, field counts, focus observations, action-to-second-frame timings and layout-shift entries are recorded per case.\n\n${report.limits.map(value => `- ${value}`).join('\n')}\n`)
  process.stdout.write(`${JSON.stringify({ status: report.status, tests: report.tests, drift: drift.length })}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runNavigationAcceptance({ output: process.argv.find(argument => argument.startsWith('--output='))?.slice(9), filter: process.argv.find(argument => argument.startsWith('--filter='))?.slice(9) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
