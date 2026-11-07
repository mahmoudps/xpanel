import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { connect } from 'node:tls'
import { navigation } from '../../packages/catalog/src/data/navigation.ts'

/**
 * Shared kit for the per-slice acceptance drivers. A driver acts only as a real client of the installed release:
 * the panel API, and the served site or mail where a criterion names them. It never reads host files and runs no shell.
 */

export const check = (id, passed, observed) => ({ id, status: passed ? 'passed' : 'failed', observed })
export const blocked = (id, reason) => ({ id, status: 'blocked', observed: { reason } })
export const safeResponse = response => ({ status: response?.status ?? null, code: typeof response?.data?.code === 'string' && /^[A-Z_]{1,64}$/.test(response.data.code) ? response.data.code : null })

const SESSION_ACTORS = ['root', 'owner', 'mailbox']
/** The listener each actor signs in on; `reseller` is reached only through `signIn`. */
export const ACTOR_ENTRY = Object.freeze({ root: 'xwhm', reseller: 'xwhm', owner: 'xpanel', mailbox: 'xmail' })
/** Every tool's page and the actor who opens it, read from the catalog so a moved route cannot leave a stale declaration. */
const PAGES = new Map(navigation.flatMap(({ surface, sections }) => sections.flatMap(section => section.pages.flatMap(page => page.tools.map(id => [id, { route: page.route, actor: surface === 'xpanel' ? 'owner' : surface === 'xmail' ? 'mailbox' : 'root' }])))))
const CHECK_ID = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

/** Declares one reviewed driver. Check IDs are the observations it owes; a missing one stays blocked in the report. */
export function tool(id, definition) {
  const { prefix, as = 'root', also = [], probe, paths, checks, unit = [], run, requests = 30, deadlineMs = 120_000, gate = id, restores = [], hostOnly = [] } = definition
  const location = PAGES.get(id), declared = definition.page
  if (location === undefined || (declared !== undefined && (declared.route !== location.route || (declared.read !== undefined && typeof declared.read !== 'string') || (declared.shows !== undefined && typeof declared.shows !== 'function')))) throw new Error(`Invalid qualification driver for ${id}`)
  const page = { ...location, read: declared?.read ?? (location.actor === as ? probe : '/api/auth/me'), ...(declared?.shows ? { shows: declared.shows } : {}) }
  const needs = [...new Set([...(definition.needs ?? []), ...(page.actor === 'root' ? [] : ['account']), ...(page.actor === 'mailbox' ? ['mailbox'] : [])])]
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(prefix ?? '') || !SESSION_ACTORS.includes(as) || typeof probe !== 'string' || !(paths instanceof RegExp) || typeof run !== 'function'
    || !Array.isArray(checks) || checks.length === 0 || new Set(checks).size !== checks.length || !checks.every(item => CHECK_ID.test(item))
    || !also.every(item => SESSION_ACTORS.includes(item) && item !== as) || !needs.every(item => ['account', 'mailbox'].includes(item)) || ([as, ...also].includes('owner') && !needs.includes('account')) || ([as, ...also].includes('mailbox') && !needs.includes('mailbox'))
    || !Number.isSafeInteger(requests) || requests < 1 || requests > 200 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 600_000
    || (restores.length > 0 && ![as, ...also].includes('root')) || !hostOnly.every(item => checks.includes(item))) throw new Error(`Invalid qualification driver for ${id}`)
  const revoked = ['SESSION-REVOKED', ...also.map(actor => `${actor.toUpperCase()}-SESSION-REVOKED`)]
  const host = ['OS-PROFILE', 'ANONYMOUS-DENIED', ...checks, ...revoked].map(item => `${prefix}-${item}`)
  const external = ['DNS', 'TLS', ...checks.filter(item => !hostOnly.includes(item)), ...revoked].map(item => `${prefix}-EXTERNAL-${item}`)
  const browser = ['BROWSER-SIGN-IN', 'BROWSER-PAGE', 'BROWSER-READ', 'BROWSER-SIGNED-OUT'].map(item => `${prefix}-${item}`)
  return Object.freeze({
    toolId: id, inventory: Object.freeze({ unit: Object.freeze(unit.map(item => Object.freeze({ ...item }))), host: Object.freeze(host), browser: Object.freeze(browser), external: Object.freeze(external) }),
    driver: Object.freeze({ prefix, as, also, probe, paths, checks, page: Object.freeze(page), run, needs, requests: requests + restores.length * 2, deadlineMs, gate, restores, hostOnly, requires_qualification_admission: definition.requires_qualification_admission === true }),
  })
}

/** Stable short name for run-scoped objects, so a rerun with another run ID never meets an earlier run's objects. */
export const runTag = runId => createHash('sha256').update(runId).digest('hex').slice(0, 8)

/** Bounded client for one signed-in session. Session values stay here and never reach evidence. */
export function apiClient(request, session) {
  const send = (method, path, body, extra = {}) => request(path, { method, cookie: session.cookie, csrf: session.csrf, ...(body === undefined ? {} : { body }), ...extra })
  return Object.freeze({
    get: (path, extra) => request(path, { cookie: session.cookie, ...extra }),
    post: (path, body = {}, extra) => send('POST', path, body, extra), put: (path, body, extra) => send('PUT', path, body, extra),
    patch: (path, body, extra) => send('PATCH', path, body, extra), delete: (path, body, extra) => send('DELETE', path, body, extra),
    anonymous: (path, options) => request(path, options),
  })
}

/** Runs one driver: every undo step runs even after a failed check, and a step that cannot confirm removal is a leftover. */
/** Fields that move on every save; what they label must still match after a restore. */
const VOLATILE = /^(?:revision|expectedRevision|authorityRevision|observedAt|.+At)$/
const settled = value => JSON.stringify(value, (key, item) => VOLATILE.test(key) ? undefined : item)

export async function runDriver(driver, { clients, prefix = driver.prefix, tag, fixture, site, requestFor, host, admitted = true, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const checks = [], undo = [], leftovers = []
  const add = (id, passed, observed) => { checks.push(check(`${prefix}-${id}`, passed, observed)); return passed }
  const block = (id, reason) => { checks.push(blocked(`${prefix}-${id}`, reason)); return false }
  const context = {
    ...clients, tag, fixture, site, host, sleep, check: add, block,
    undo: (label, step) => { undo.unshift({ label, step }) },
    /** A success status, or the check fails with the status and stable code only. */
    ok: (id, response, accepted = [200, 201, 202, 204]) => add(id, accepted.includes(response?.status), safeResponse(response)),
    /** The exact refusal the criterion names, as a stable code or an HTTP status; anything else fails. */
    refused: (id, response, expected) => {
      return add(id, typeof expected === 'number' ? response?.status === expected : response?.status >= 400 && response?.data?.code === expected, { ...safeResponse(response), expected })
    },
    /** Signs in one more principal the driver made; its session is revoked with the undo steps. */
    signIn: async (actor, credentials) => {
      const request = requestFor(actor), response = await request('/api/auth/login', { method: 'POST', body: credentials })
      const cookie = response.setCookie?.find(value => value.startsWith(`__Host-${ACTOR_ENTRY[actor]}_session=`))?.split(';')[0]
      if (response.status !== 200 || cookie === undefined) return { client: null, response }
      const client = apiClient(request, { cookie, csrf: response.data?.csrfToken })
      undo.unshift({ label: `${actor} session`, step: async () => (await client.post('/api/auth/logout')).status === 200 })
      return { client, response }
    },
    /** Polls a read until accepted, bounded by attempts; each attempt spends one request. */
    until: async (read, accepted, { attempts = 20, delayMs = 1000 } = {}) => {
      let last
      for (let attempt = 0; attempt < attempts; attempt++) {
        last = await read()
        if (accepted(last)) return { settled: true, last, attempts: attempt + 1 }
        await sleep(delayMs)
      }
      return { settled: false, last, attempts }
    },
  }
  let failure = null
  const before = new Map(), restores = driver.restores ?? []
  for (const path of restores) {
    const read = await clients.root.get(path).catch(() => null)
    if (read?.status === 200) before.set(path, settled(read.data))
  }
  if (driver.requires_qualification_admission && !admitted) {
    for (const id of driver.checks) block(id, 'This tool needs qualification admission: its gate refuses writes until it is verified, and this host is not in qualification mode.')
  } else if (before.size !== restores.length) {
    for (const id of driver.checks) block(id, 'Shared state could not be read first, so no restore could be proved and the driver did not run.')
  } else {
    try { await driver.run(context) } catch { failure = 'The driver did not complete.' }
  }
  for (const { label, step } of undo) {
    try { if (await step() === false) leftovers.push(label) } catch { leftovers.push(label) }
  }
  // A restore is proved against the first read, not taken from the undo step's own answer.
  for (const [path, value] of before) {
    const read = await clients.root.get(path).catch(() => null)
    if (read?.status !== 200 || settled(read.data) !== value) leftovers.push(`shared state ${path}`)
  }
  return { checks, cleanup: { ok: leftovers.length === 0, errors: leftovers.map(label => `Cleanup not confirmed: ${label}.`), ...(leftovers.length ? { leftovers: { objects: leftovers } } : {}) }, failure }
}

const password = () => `Xq-${randomBytes(18).toString('base64url')}-9a`

/**
 * One account and mailbox per run for the owner and mailbox drivers, created and terminated through the API. It uses a
 * run-scoped plan and feature list so existing accounts are never touched. Secrets stay in memory only.
 */
export async function createFixture(root, { tag, domainSuffix = 'example.net', mailbox = false }) {
  const username = `xq${tag}`.slice(0, 16), domain = `${username}.${domainSuffix}`, created = {}
  const fixture = { username, domain, accountId: null, password: password(), mailbox: null, cleanup: { ok: false, errors: [] } }
  const need = (response, what) => {
    if (![200, 201].includes(response.status)) throw new Error(`QUALIFICATION_FIXTURE_${what}:${response.status}:${safeResponse(response).code ?? 'none'}`)
    return response.data
  }
  try {
    created.list = need(await root.post('/api/feature-lists', { name: `xq-${tag}`, ownerId: null, disabled: [] }), 'FEATURES').featureList.id
    created.plan = need(await root.post('/api/plans', { name: `xq-${tag}`, featureListId: created.list, resources: { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 } }), 'PLAN').plan.id
    const body = need(await root.post('/api/accounts', { username, password: fixture.password, primaryDomain: domain, planId: created.plan }, { idempotencyKey: `xq-${tag}` }), 'ACCOUNT')
    fixture.accountId = body.account?.id ?? null
    if (typeof fixture.accountId !== 'string') throw new Error('QUALIFICATION_FIXTURE_ACCOUNT_ID')
    if (mailbox) {
      const address = `xq@${domain}`, secret = password()
      need(await root.post('/api/service-users', { accountId: fixture.accountId, login: address, password: secret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 256 }), 'MAILBOX')
      fixture.mailbox = { address, password: secret }
    }
  } catch (error) {
    await destroyFixture(root, fixture, created)
    throw error
  }
  fixture.destroy = () => destroyFixture(root, fixture, created)
  return fixture
}

async function destroyFixture(root, fixture, created) {
  const errors = [], gone = async (what, response) => { if (![200, 204, 404].includes(response.status)) errors.push(`${what}: ${JSON.stringify(safeResponse(response))}`) }
  for (const [what, step] of [
    ['account', fixture.accountId && (() => root.delete(`/api/accounts/${fixture.accountId}`, { confirmUsername: fixture.username }))],
    ['plan', created.plan && (() => root.delete(`/api/plans/${created.plan}`))],
    ['feature list', created.list && (() => root.delete(`/api/feature-lists/${created.list}`))],
  ]) {
    if (!step) continue
    try { await gone(what, await step()) } catch { errors.push(`${what}: request failed`) }
  }
  fixture.cleanup = { ok: errors.length === 0, errors }
  return fixture.cleanup
}

/**
 * The served site at the reviewed address, as any visitor reaches it; a fixture domain needs no public DNS. Redirects are
 * reported, not followed. `certificate` returns the presented leaf for criteria that name it.
 */
export function siteClient({ address, deadline }) {
  const timeout = () => Math.max(1, Math.min(5000, deadline - Date.now()))
  const get = (domain, path, { headers = {}, secure = false, method = 'GET' } = {}) => new Promise((done, reject) => {
    const request = (secure ? https : http).request({ host: address, port: secure ? 443 : 80, path, method, agent: false, timeout: timeout(), headers: { host: domain, 'user-agent': 'xpanel-qualification/1', ...headers },
      ...(secure ? { servername: domain, rejectUnauthorized: false } : {}) }, response => {
      const chunks = []; let length = 0
      response.on('data', chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) request.destroy(new Error('QUALIFICATION_SITE_SIZE')); else chunks.push(chunk) })
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, bytes: length, text: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.once('timeout', () => request.destroy(new Error('QUALIFICATION_SITE_DEADLINE')))
    request.once('error', reject)
    request.end()
  })
  const certificate = domain => new Promise((done, reject) => {
    const socket = connect({ host: address, port: 443, servername: domain, rejectUnauthorized: false, timeout: timeout() })
    socket.once('secureConnect', () => { const peer = socket.getPeerCertificate(); socket.destroy(); done({ serialNumber: peer.serialNumber, subject: peer.subject?.CN ?? null, fingerprint256: peer.fingerprint256 }) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('QUALIFICATION_SITE_DEADLINE')) })
    socket.once('error', reject)
  })
  return Object.freeze({ get, certificate })
}

/** The other panels live on the same host name at their own listener ports. */
export const entryOrigin = (origin, port) => { const url = new URL(origin); url.port = String(port); return url.origin }

/** The origin name resolves, from outside the host, to the reviewed installed address. */
export async function externalDnsCheck(id, hostname, address, resolve = name => lookup(name, { all: true, verbatim: true })) {
  const addresses = (await resolve(hostname)).map(entry => entry.address)
  return check(id, addresses.includes(address), { hostname, addresses, expected: address })
}

/** The certificate served at the reviewed address verifies for the origin name with the observer's normal trust store. */
export function externalTlsCheck(id, { hostname, port, address, now = Date.now(), open = connect }) {
  return new Promise(resolveCheck => {
    const socket = open({ host: address, port, servername: hostname, rejectUnauthorized: true, timeout: 5000 })
    const done = value => { socket.destroy(); resolveCheck(value) }
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      const valid = socket.authorized === true && Date.parse(certificate.valid_from) <= now && now < Date.parse(certificate.valid_to)
      done(check(id, valid, { authorized: socket.authorized, issuer: certificate.issuer?.O ?? certificate.issuer?.CN ?? null, validFrom: certificate.valid_from, validTo: certificate.valid_to, fingerprint256: certificate.fingerprint256 }))
    })
    socket.once('timeout', () => done(check(id, false, { reason: 'TLS handshake timed out.' })))
    socket.once('error', error => done(check(id, false, { reason: 'TLS verification failed.', code: typeof error?.code === 'string' ? error.code : null })))
  })
}

const DISPLAY_KEY = /^(?:name|domain|hostname|host|username|login|address|email|title|label|mount|filesystem|zone|service|unit|description|path|subject)$/i
const NOT_DISPLAY = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{32,}|\d{4}-\d{2}-\d{2}T.*)$/i

/** Identifying strings of API replies: what a page must really show, never the signed-in actor's own name from the shell. */
export function displayValues(replies, actor) {
  const found = new Set()
  const walk = (value, key) => {
    if (typeof value === 'string') { if (DISPLAY_KEY.test(key) && value.length >= 4 && value.length <= 120 && value !== actor && !NOT_DISPLAY.test(value)) found.add(value) }
    else if (Array.isArray(value)) for (const item of value) walk(item, key)
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, name)
  }
  walk(replies, '')
  return [...found].slice(0, 200)
}

/**
 * Real Chromium, the actor's own sign-in form and page. A page counts only when values from API replies appear in its
 * main region: the declared read, plus whatever the page itself fetched. No value to compare leaves the check blocked.
 */
export async function pageChecks(driver, { page, origin, credentials }) {
  const { prefix } = driver, checks = [], route = driver.page.route, replies = []
  await page.goto(`${origin}/login?lang=en`)
  await page.locator('#login-username').fill(credentials.username)
  await page.locator('#login-password').fill(credentials.password)
  if (credentials.totpCode !== undefined) await page.locator('#login-otp').fill(credentials.totpCode)
  const [login] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST'),
    page.locator('#login-password').press('Enter'),
  ])
  checks.push(check(`${prefix}-BROWSER-SIGN-IN`, login.status() === 200, { status: login.status() }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/') && response.status() === 200) replies.push(response.json().catch(() => null))
  })
  const opened = await page.goto(`${origin}${route}${route.includes('?') ? '&' : '?'}lang=en`)
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  const closed = await page.locator('[data-tool-availability="unverified"]').count()
  checks.push(check(`${prefix}-BROWSER-PAGE`, opened?.status() === 200 && closed === 0, { status: opened?.status() ?? null, route, closedSurfaces: closed, qualificationMode: await page.locator('[data-qualification-mode]').count() === 1 }))
  const read = await page.request.get(`${origin}${driver.page.read}`, { failOnStatusCode: false, maxRedirects: 0 })
  const data = await read.json().catch(() => null), named = read.status() === 200 ? driver.page.shows?.(data) : undefined
  const text = await page.locator('main').evaluate(main => [main.innerText, ...[...main.querySelectorAll('input, select, textarea')].map(item => item.value)].join('\n')).catch(() => '')
  const seen = displayValues([data, ...await Promise.all(replies)], credentials.username)
  const shown = value => typeof value === 'string' && value.length > 0 && text.includes(value)
  if (driver.page.shows) checks.push(check(`${prefix}-BROWSER-READ`, Array.isArray(named) && named.length > 0 && named.every(shown), { status: read.status(), expected: named?.length ?? null }))
  else if (seen.length === 0) checks.push(blocked(`${prefix}-BROWSER-READ`, 'No API reply held a value to compare with the page.'))
  else checks.push(check(`${prefix}-BROWSER-READ`, seen.some(shown), { status: read.status(), compared: seen.length, matched: seen.filter(shown).length }))
  const [logout] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST'),
    page.evaluate(() => document.querySelector('[data-action="logout"]')?.click()),
  ])
  const revoked = await page.request.get(`${origin}${driver.page.read}`, { failOnStatusCode: false, maxRedirects: 0 })
  const signedOut = logout.status() === 200 && revoked.status() === 401
  checks.push(check(`${prefix}-BROWSER-SIGNED-OUT`, signedOut, { logoutStatus: logout.status(), subsequentRead: revoked.status() }))
  return { checks, signedOut }
}
