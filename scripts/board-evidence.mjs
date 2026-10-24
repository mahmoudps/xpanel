import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BOARD_LIMITS = Object.freeze({ page: 0.005, tile: 0.01, tileSize: 200 })
export const REQUIRED_BOARD_SCREENS = Object.freeze(['dashboard', 'home-desktop', 'home-phone', 'inbox', 'compose'])
export const evidenceDigest = value => createHash('sha256').update(value).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const token = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const bytes = value => value instanceof Uint8Array

/** Equal dimensions are required; a small image cannot crop away a failing region. */
export function scoreBoardPixels(referenceBytes, candidateBytes) {
  const reference = PNG.sync.read(Buffer.from(referenceBytes))
  const candidate = PNG.sync.read(Buffer.from(candidateBytes))
  const { width, height } = reference
  if (!positive(width) || !positive(height) || width !== candidate.width || height !== candidate.height) throw new Error('board-dimensions-mismatch')
  const options = { threshold: 0.1, includeAA: false }
  const mismatches = pixelmatch(reference.data, candidate.data, null, width, height, options)
  const tiles = []
  for (let y = 0; y < height; y += BOARD_LIMITS.tileSize) for (let x = 0; x < width; x += BOARD_LIMITS.tileSize) {
    const w = Math.min(BOARD_LIMITS.tileSize, width - x)
    const h = Math.min(BOARD_LIMITS.tileSize, height - y)
    const left = Buffer.alloc(w * h * 4)
    const right = Buffer.alloc(w * h * 4)
    for (let row = 0; row < h; row++) {
      const start = ((y + row) * width + x) * 4
      reference.data.copy(left, row * w * 4, start, start + w * 4)
      candidate.data.copy(right, row * w * 4, start, start + w * 4)
    }
    const different = pixelmatch(left, right, null, w, h, options)
    tiles.push({ x, y, width: w, height: h, mismatches: different, ratio: different / (w * h) })
  }
  const pageRatio = mismatches / (width * height)
  const worstTileRatio = Math.max(...tiles.map(tile => tile.ratio))
  return { width, height, pageRatio, worstTileRatio, tiles, pass: pageRatio <= BOARD_LIMITS.page && worstTileRatio <= BOARD_LIMITS.tile }
}

const loopback = value => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash ? url : null
  } catch { return null }
}

const captureProblem = (capture, expectedInputDigest, expectedSize) => {
  if (!capture || !token(capture.captureId) || !token(capture.processNonce) || !positive(capture.processId)) return 'capture-witness-missing'
  if (!loopback(capture.url) || capture.responseStatus !== 200) return 'capture-response-invalid'
  if (!digest(capture.inputDigest) || capture.inputDigest !== expectedInputDigest) return 'capture-input-digest-mismatch'
  if (!bytes(capture.responseBytes) || capture.responseBytes.length === 0 || !bytes(capture.pngBytes) || capture.pngBytes.length === 0 || typeof capture.dom !== 'string' || !capture.dom) return 'capture-content-missing'
  if (capture.responseDigest !== evidenceDigest(capture.responseBytes) || capture.domDigest !== evidenceDigest(capture.dom) || capture.pngDigest !== evidenceDigest(capture.pngBytes)) return 'capture-content-digest-mismatch'
  if (typeof capture.capturedAt !== 'string' || !Number.isFinite(Date.parse(capture.capturedAt)) || new Date(capture.capturedAt).toISOString() !== capture.capturedAt) return 'capture-time-invalid'
  const layout = capture.layout
  if (!layout || layout.modified !== false || layout.viewportWidth !== expectedSize.width || layout.viewportHeight !== expectedSize.height) return 'capture-layout-invalid'
  if (['documentScrollWidth', 'bodyScrollWidth', 'documentScrollHeight', 'bodyScrollHeight'].some(key => !Number.isFinite(layout[key]) || layout[key] < 0)) return 'capture-layout-observations-missing'
  if (layout.documentScrollWidth > layout.viewportWidth || layout.bodyScrollWidth > layout.viewportWidth) return 'capture-horizontal-overflow'
  if (layout.documentScrollHeight > layout.viewportHeight || layout.bodyScrollHeight > layout.viewportHeight) return 'capture-content-outside-frame'
  if (['rootOverflowX', 'rootOverflowY', 'bodyOverflowX', 'bodyOverflowY'].some(key => typeof layout[key] !== 'string' || /^(?:hidden|clip)$/.test(layout[key]))) return 'capture-root-overflow-concealed'
  return null
}

/** Validate witnesses supplied by an audited local capture runner, not untrusted claims.
 * This module neither captures pages nor discovers/ships private reference assets.
 * Independent processes, served content and input digests establish the comparison
 * boundary. PNG byte inequality is deliberately not an authenticity predicate.
 */
export function evaluateBoardEvidence(evidence, mandatoryScreens = REQUIRED_BOARD_SCREENS) {
  const failed = (reason, screens = []) => ({ status: 'failed', accepted: false, reason, screens })
  if (!Array.isArray(mandatoryScreens) || mandatoryScreens.length === 0 || mandatoryScreens.some(id => !token(id)) || new Set(mandatoryScreens).size !== mandatoryScreens.length) return failed('mandatory-screens-invalid')
  if (evidence?.referenceInputsAvailable === false) return { status: 'blocked', accepted: false, reason: 'reference-inputs-unavailable', screens: [] }
  if (evidence?.referenceInputsAvailable !== true) return failed('reference-input-state-missing')
  if (!digest(evidence.sourceBeforeDigest) || evidence.sourceBeforeDigest !== evidence.sourceAfterDigest) return failed('source-drift-or-missing-digest')
  if (!Array.isArray(evidence.screens) || evidence.screens.length !== mandatoryScreens.length || new Set(evidence.screens.map(row => row?.id)).size !== mandatoryScreens.length) return failed('mandatory-screen-set-mismatch')
  const rows = []
  const captures = new Set()
  for (const id of mandatoryScreens) {
    const row = evidence.screens.find(screen => screen?.id === id)
    if (!row || !positive(row.width) || !positive(row.height) || !digest(row.referenceInputDigest) || row.referenceInputDigest === evidence.sourceBeforeDigest) return failed('screen-manifest-invalid', rows)
    const reference = row.reference
    const candidate = row.candidate
    for (const [capture, inputDigest] of [[reference, row.referenceInputDigest], [candidate, evidence.sourceBeforeDigest]]) {
      const problem = captureProblem(capture, inputDigest, row)
      if (problem) return failed(`${id}:${problem}`, rows)
    }
    if (reference.captureId === candidate.captureId || reference.processId === candidate.processId || reference.processNonce === candidate.processNonce || loopback(reference.url).origin === loopback(candidate.url).origin) return failed(`${id}:comparison-not-independent`, rows)
    const negative = row.negativeControl
    if (!negative || negative.kind !== 'padding-inline-start' || negative.pixels !== 1 || negative.baseDomDigest !== candidate.domDigest || negative.capture?.domDigest === candidate.domDigest) return failed(`${id}:negative-control-missing`, rows)
    const problem = captureProblem(negative.capture, evidence.sourceBeforeDigest, row)
    if (problem) return failed(`${id}:negative-${problem}`, rows)
    for (const capture of [reference, candidate, negative.capture]) {
      if (captures.has(capture.captureId)) return failed(`${id}:capture-reused`, rows)
      captures.add(capture.captureId)
    }
    if (negative.capture.captureId === candidate.captureId || negative.capture.captureId === reference.captureId || negative.capture.processNonce !== candidate.processNonce || negative.capture.processId !== candidate.processId || negative.capture.url !== candidate.url || negative.capture.responseDigest !== candidate.responseDigest) return failed(`${id}:negative-control-unbound`, rows)
    if (Date.parse(negative.capture.capturedAt) < Date.parse(candidate.capturedAt)) return failed(`${id}:negative-control-precedes-candidate`, rows)
    try {
      const score = scoreBoardPixels(reference.pngBytes, candidate.pngBytes)
      const negativeScore = scoreBoardPixels(reference.pngBytes, negative.capture.pngBytes)
      if (score.width !== row.width || score.height !== row.height || negativeScore.width !== row.width || negativeScore.height !== row.height) return failed(`${id}:capture-dimensions-mismatch`, rows)
      rows.push({ id, accepted: score.pass && !negativeScore.pass, score, negativeScore,
        witnesses: { referenceInputDigest: row.referenceInputDigest, sourceDigest: evidence.sourceBeforeDigest, referenceResponseDigest: reference.responseDigest, candidateResponseDigest: candidate.responseDigest, referenceDomDigest: reference.domDigest, candidateDomDigest: candidate.domDigest, referencePngDigest: reference.pngDigest, candidatePngDigest: candidate.pngDigest,
          referenceProcessId: reference.processId, candidateProcessId: candidate.processId, referenceProcessNonce: reference.processNonce, candidateProcessNonce: candidate.processNonce,
          referenceCaptureId: reference.captureId, candidateCaptureId: candidate.captureId, negativeCaptureId: negative.capture.captureId,
          referenceCapturedAt: reference.capturedAt, candidateCapturedAt: candidate.capturedAt, negativeCapturedAt: negative.capture.capturedAt,
          referenceOrigin: loopback(reference.url).origin, candidateOrigin: loopback(candidate.url).origin } })
    } catch { return failed(`${id}:invalid-png-or-dimensions`, rows) }
  }
  return rows.every(row => row.accepted) ? { status: 'passed', accepted: true, reason: null, screens: rows } : failed('screen-budget-or-negative-control-failed', rows)
}

/** Call this at the explicit qualification boundary; blocked is never a pass. */
export function assertBoardEvidence(evidence, mandatoryScreens = REQUIRED_BOARD_SCREENS) {
  const result = evaluateBoardEvidence(evidence, mandatoryScreens)
  if (!result.accepted) throw new Error(`board-evidence-${result.status}:${result.reason}`)
  return result
}

export const isBoardRunnerMain = url => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url)
const repository = fileURLToPath(new URL('../', import.meta.url))
const assetTypes = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' })
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

async function sourceTreeDigest() {
  const { collectSnapshotFiles, computeSourceDigest } = await import('./vm/source-snapshot.mjs')
  const files = await Promise.all(collectSnapshotFiles(repository).map(async file => ({ path: file, sha256: evidenceDigest(await readFile(path.join(repository, file))) })))
  return computeSourceDigest(files)
}

async function referenceInputs(file) {
  const index = await realpath(file)
  const root = await realpath(process.env.XP_REFERENCE_ROOT || path.dirname(index))
  if (!within(root, index)) throw new Error('reference-index-outside-root')
  const files = new Map()
  let totalBytes = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) throw new Error('reference-symlink-not-supported')
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile() && assetTypes[path.extname(entry.name).toLowerCase()]) {
        const size = (await stat(filename)).size
        totalBytes += size
        if (size > 8 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024 || files.size >= 4096) throw new Error('reference-input-budget-exceeded')
        files.set(path.relative(root, filename).split(path.sep).join('/'), { filename, sha256: evidenceDigest(await readFile(filename)) })
      }
    }
  }
  await visit(root)
  const indexPath = path.relative(root, index).split(path.sep).join('/')
  if (!files.has(indexPath)) throw new Error('reference-index-not-readable')
  return { root, indexPath, files, digest: evidenceDigest([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}\0${value.sha256}\n`).join('')) }
}

async function serveCaptureChild(role, runnerFile, screenId) {
  if (!process.send || !['reference', 'candidate'].includes(role)) throw new Error('capture-child-context-required')
  const module = await import(pathToFileURL(path.resolve(runnerFile)).href)
  const screen = module.boardScreens.find(row => row.id === screenId)
  if (!screen) throw new Error('capture-screen-not-declared')
  const inputs = role === 'reference' ? await referenceInputs(process.env[screen.referenceEnv]) : null
  const html = role === 'candidate' ? screen.renderCandidate() : null
  const inputDigest = inputs?.digest ?? await sourceTreeDigest()
  const nonce = randomUUID()
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405);response.end();return }
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.search) { response.writeHead(404);response.end();return }
      if (role === 'candidate') {
        if (url.pathname !== '/screen') { response.writeHead(404);response.end();return }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });response.end(request.method === 'HEAD' ? undefined : html);return
      }
      const relative = url.pathname === '/screen' ? inputs.indexPath : decodeURIComponent(url.pathname).replace(/^\//, '')
      if (relative.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) { response.writeHead(404);response.end();return }
      const file = inputs.files.get(relative)
      if (!file || !within(inputs.root, await realpath(file.filename))) { response.writeHead(404);response.end();return }
      const body = await readFile(file.filename)
      if (evidenceDigest(body) !== file.sha256) { response.writeHead(409);response.end();return }
      response.writeHead(200, { 'content-type': assetTypes[path.extname(file.filename).toLowerCase()], 'cache-control': 'no-store' });response.end(request.method === 'HEAD' ? undefined : body)
    } catch { response.writeHead(404);response.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve) })
  process.send({ type: 'ready', processId: process.pid, processNonce: nonce, inputDigest, origin: `http://127.0.0.1:${server.address().port}`, documentPath: inputs ? `/${inputs.indexPath.split('/').map(encodeURIComponent).join('/')}` : '/screen' })
  process.on('message', async message => {
    if (message?.type === 'check') {
      try { process.send({ type: 'digest', value: role === 'reference' ? (await referenceInputs(process.env[screen.referenceEnv])).digest : await sourceTreeDigest() }) }
      catch { process.send({ type: 'digest', value: null }) }
    }
    if (message?.type === 'stop') server.close(() => process.exit(0))
  })
}

async function startCaptureChild(role, screen) {
  const child = fork(fileURLToPath(import.meta.url), ['--board-server', role, fileURLToPath(screen.runnerUrl), screen.id], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const receive = type => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup();reject(new Error('capture-child-timeout')) }, 15000)
    const message = value => { if (value?.type === type) { cleanup();resolve(value) } }
    const ended = () => { cleanup();reject(new Error('capture-child-exited')) }
    const cleanup = () => { clearTimeout(timeout);child.off('message', message);child.off('exit', ended);child.off('error', ended) }
    child.on('message', message);child.once('exit', ended);child.once('error', ended)
  })
  let ready
  try { ready = await receive('ready') } catch (error) { child.kill();throw error }
  if (ready.processId !== child.pid || !token(ready.processNonce) || !digest(ready.inputDigest) || !loopback(`${ready.origin}/screen`)) { child.kill();throw new Error('capture-child-witness-invalid') }
  return { ...ready, async check() { const answer = receive('digest');child.send({ type: 'check' });return (await answer).value },
    async stop() { if (child.exitCode !== null) return;await new Promise(resolve => { const timer = setTimeout(() => { child.kill();resolve() }, 5000);child.once('exit', () => { clearTimeout(timer);resolve() });if (child.connected) child.send({ type: 'stop' });else child.kill() }) } }
}

async function captureScreen(browser, witness, screen, baseDomDigest) {
  const page = await browser.newPage({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: 1 })
  const external = []
  const pending = []
  const blocked = []
  const errors = []
  try {
    page.on('pageerror', () => errors.push('page-exception'))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (!['GET', 'HEAD'].includes(route.request().method())) { blocked.push('mutation-request');return route.abort() }
      if (url.origin === witness.origin || (url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname))) return route.continue()
      blocked.push('external-input-not-supported');return route.abort()
    })
    await page.routeWebSocket('**/*', socket => { blocked.push('websocket-not-supported');socket.close() })
    page.on('response', response => {
      if (new URL(response.url()).origin === witness.origin) return
      pending.push((async () => { try { const body = await response.body();if (!response.ok() || body.length > 4 * 1024 * 1024) throw new Error();external.push({ urlDigest: evidenceDigest(response.url()), bodyDigest: evidenceDigest(body) }) } catch { blocked.push('external-input-unreadable') } })())
    })
    const url = `${witness.origin}${witness.documentPath}`
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    const fontsReady = await page.evaluate(async () => { let ready = false;await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 5000))]);return ready && ![...document.fonts].some(face => face.status === 'error') })
    await Promise.all(pending)
    if (!fontsReady || blocked.length || errors.length || !response || response.status() !== 200) throw new Error('capture-inputs-or-page-unavailable')
    if (baseDomDigest) {
      if (evidenceDigest(await page.content()) !== baseDomDigest) throw new Error('negative-base-dom-changed')
      await page.evaluate(() => { const target = document.querySelector('main') ?? document.body;const padding = Number.parseFloat(getComputedStyle(target).paddingInlineStart);target.style.paddingInlineStart = `${padding + 1}px` })
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // No capture-only root overflow, direction or font coercion is applied. The
    // explicit negative control above is the sole permitted test perturbation.
    const layout = await page.evaluate(() => ({ modified: false, viewportWidth: innerWidth, viewportHeight: innerHeight, documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, documentScrollHeight: document.documentElement.scrollHeight, bodyScrollHeight: document.body.scrollHeight, rootOverflowX: getComputedStyle(document.documentElement).overflowX, rootOverflowY: getComputedStyle(document.documentElement).overflowY, bodyOverflowX: getComputedStyle(document.body).overflowX, bodyOverflowY: getComputedStyle(document.body).overflowY }))
    const responseBytes = await response.body()
    const dom = await page.content()
    const pngBytes = await page.screenshot({ type: 'png' })
    return { captureId: randomUUID(), processId: witness.processId, processNonce: witness.processNonce, inputDigest: witness.inputDigest, capturedAt: new Date().toISOString(), url, responseStatus: response.status(), responseBytes, responseDigest: evidenceDigest(responseBytes), dom, domDigest: evidenceDigest(dom), pngBytes, pngDigest: evidenceDigest(pngBytes), layout, externalInputsDigest: evidenceDigest(JSON.stringify(external.sort((a, b) => a.urlDigest.localeCompare(b.urlDigest)))) }
  } finally { await page.close() }
}

/** These commands compare current synthetic live-shaped renderers, not authenticated
 * production documents. No JSON receipt from another process is trusted as a pass:
 * this runner starts and observes its own independent loopback server children.
 */
export async function runBoardDiagnostics(screens, { aggregate = false } = {}) {
  const blocked = reason => ({ status: 'blocked', accepted: false, qualification: 'not-run', diagnosticOnly: true, reason })
  const missing = screens.filter(screen => !process.env[screen.referenceEnv]).map(screen => screen.id)
  if (missing.length) { const result = { ...blocked('external-references-required'), missingScreens: missing, requiredEnvironment: screens.filter(screen => missing.includes(screen.id)).map(screen => screen.referenceEnv) };console.log(JSON.stringify(result));process.exitCode = 2;return result }
  const mandatory = aggregate ? REQUIRED_BOARD_SCREENS : screens.map(screen => screen.id)
  if (aggregate && (screens.length !== mandatory.length || mandatory.some(id => !screens.some(screen => screen.id === id)))) throw new Error('aggregate-mandatory-screen-set-mismatch')
  let browser
  let sourceBeforeDigest
  const rows = []
  try {
    sourceBeforeDigest = await sourceTreeDigest()
    for (const screen of screens) await referenceInputs(process.env[screen.referenceEnv])
    const { default: playwright } = await import('../node_modules/@playwright/test/index.js')
    browser = await playwright.chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true })
    for (const screen of screens) {
      let referenceServer, candidateServer
      try {
        referenceServer = await startCaptureChild('reference', screen)
        candidateServer = await startCaptureChild('candidate', screen)
        if (candidateServer.inputDigest !== sourceBeforeDigest) throw new Error('candidate-source-changed')
        const reference = await captureScreen(browser, referenceServer, screen)
        const candidate = await captureScreen(browser, candidateServer, screen)
        const negativeCapture = await captureScreen(browser, candidateServer, screen, candidate.domDigest)
        if (negativeCapture.externalInputsDigest !== candidate.externalInputsDigest) throw new Error('negative-external-inputs-changed')
        if (await referenceServer.check() !== referenceServer.inputDigest || await candidateServer.check() !== sourceBeforeDigest) throw new Error('capture-input-drift')
        rows.push({ id: screen.id, width: screen.width, height: screen.height, referenceInputDigest: referenceServer.inputDigest, reference, candidate, negativeControl: { kind: 'padding-inline-start', pixels: 1, baseDomDigest: candidate.domDigest, capture: negativeCapture } })
      } finally { await Promise.all([referenceServer?.stop(), candidateServer?.stop()]) }
    }
    const evidence = { referenceInputsAvailable: true, sourceBeforeDigest, sourceAfterDigest: await sourceTreeDigest(), screens: rows }
    const result = evaluateBoardEvidence(evidence, mandatory)
    const report = { ...result, diagnosticOnly: true, qualification: 'not-run', candidateKind: 'current-live-shaped-fixture', completeMandatorySet: aggregate, sourceBeforeDigest, sourceAfterDigest: evidence.sourceAfterDigest, limitations: ['Synthetic live-shaped documents only; no authenticated hosting qualification.', 'No interaction or Arabic reference acceptance is implied by the default product-screen set.', 'Raw external references remain local and are never included in the source or release.'], externalInputs: rows.map(row => ({ id: row.id, reference: row.reference.externalInputsDigest, candidate: row.candidate.externalInputsDigest, negative: row.negativeControl.capture.externalInputsDigest })) }
    const outDir = process.env.XP_FIDELITY_OUT || path.join(repository, '.artifacts', 'board-fidelity')
    await mkdir(outDir, { recursive: true })
    for (const row of rows) for (const [kind, capture] of [['reference', row.reference], ['candidate', row.candidate], ['negative', row.negativeControl.capture]]) await writeFile(path.join(outDir, `${row.id}-${kind}.png`), capture.pngBytes)
    await writeFile(path.join(outDir, aggregate ? 'aggregate-report.json' : `${screens[0].id}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ status: result.status, diagnosticOnly: true, qualification: 'not-run', completeMandatorySet: aggregate }))
    assertBoardEvidence(evidence, mandatory)
    return report
  } catch (error) {
    const reason = typeof error?.message === 'string' && /^[a-z0-9:-]+$/.test(error.message) ? error.message : 'capture-runner-unavailable'
    const result = { ...blocked(reason), ...(reason.startsWith('board-evidence-failed:') ? { status: 'failed' } : {}), capturedScreens: rows.length }
    console.log(JSON.stringify(result));process.exitCode = 1;return result
  } finally { await browser?.close() }
}

if (isBoardRunnerMain(import.meta.url) && process.argv[2] === '--board-server') {
  serveCaptureChild(process.argv[3], process.argv[4], process.argv[5]).catch(() => process.exit(1))
}
