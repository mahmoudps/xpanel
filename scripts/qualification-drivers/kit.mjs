import { createHash, randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { connect } from 'node:tls'
import { navigation } from '../../packages/catalog/src/data/navigation.ts'

/**
 * Shared kit for the per-slice acceptance drivers. A driver acts only as a real client of the installed release:
 * the panel API, and the served site or mail where a criterion names them. It never reads host files and runs no shell.
 */

export const check = (id, passed, observed) => ({ id, status: passed ? 'passed' : 'failed', observed })
export const blocked = (id, reason) => ({ id, status: 'blocked', observed: { reason } })
/**
 * Why a run stopped, only when the cause is one of the runner's own constant codes: a request over budget, a spent
 * deadline, a transport code or a browser timeout. Any other message may carry page or host text and is left out.
 */
const TRANSPORT_CAUSES = new Map([['Qualification request exceeds the bounded endpoint inventory', 'REQUEST_BUDGET_SPENT'], ['Qualification deadline expired', 'DEADLINE_EXPIRED']])
export const failureCause = error => {
  const message = typeof error?.message === 'string' ? error.message : ''
  const cause = TRANSPORT_CAUSES.get(message) ?? (/^QUALIFICATION_[A-Z_]{1,40}$/.test(message) ? message : error?.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : null)
  return cause === null ? '' : ` Cause: ${cause}.`
}
export const safeResponse = response => ({ status: response?.status ?? null, code: typeof response?.data?.code === 'string' && /^[A-Z_]{1,64}$/.test(response.data.code) ? response.data.code : null })

const SESSION_ACTORS = ['root', 'owner', 'mailbox']
/** The listener each actor signs in on; `reseller` is reached only through `signIn`. */
export const ACTOR_ENTRY = Object.freeze({ root: 'xwhm', reseller: 'xwhm', owner: 'xpanel', mailbox: 'xmail' })
/** Every tool's page and the actor who opens it, read from the catalog so a moved route cannot leave a stale declaration. */
const PAGES = new Map(navigation.flatMap(({ surface, sections }) => sections.flatMap(section => section.pages.flatMap(page => page.tools.map(id => [id, { route: page.route, actor: surface === 'xpanel' ? 'owner' : surface === 'xmail' ? 'mailbox' : 'root' }])))))
const CHECK_ID = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

/** Declares one reviewed driver. Check IDs are the observations it owes; a missing one stays blocked in the report. */
export function tool(id, definition) {
  const { prefix, as = 'root', also = [], probe, paths, checks, unit = [], run, requests = 30, deadlineMs = 120_000, gate = id, restores = [], hostOnly = [], accounts = 0 } = definition
  const location = PAGES.get(id), declared = definition.page
  if (location === undefined || (declared !== undefined && (declared.route !== location.route || (declared.read !== undefined && typeof declared.read !== 'string') || (declared.shows !== undefined && typeof declared.shows !== 'function')))) throw new Error(`Invalid qualification driver for ${id}`)
  const page = { ...location, read: declared?.read ?? (location.actor === as ? probe : '/api/auth/me'), ...(declared?.shows ? { shows: declared.shows } : {}) }
  const needs = [...new Set([...(definition.needs ?? []), ...(page.actor === 'root' ? [] : ['account']), ...(page.actor === 'mailbox' ? ['mailbox'] : [])])]
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(prefix ?? '') || !SESSION_ACTORS.includes(as) || typeof probe !== 'string' || !(paths instanceof RegExp) || typeof run !== 'function'
    || !Array.isArray(checks) || checks.length === 0 || new Set(checks).size !== checks.length || !checks.every(item => CHECK_ID.test(item))
    || !also.every(item => SESSION_ACTORS.includes(item) && item !== as) || !needs.every(item => ['account', 'mailbox'].includes(item)) || ([as, ...also].includes('owner') && !needs.includes('account')) || ([as, ...also].includes('mailbox') && !needs.includes('mailbox'))
    || !Number.isSafeInteger(requests) || requests < 1 || requests > 200 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 600_000
    || !Number.isSafeInteger(accounts) || accounts < 0 || accounts > 10
    || (restores.length > 0 && ![as, ...also].includes('root')) || !hostOnly.every(item => checks.includes(item))) throw new Error(`Invalid qualification driver for ${id}`)
  const revoked = ['SESSION-REVOKED', ...also.map(actor => `${actor.toUpperCase()}-SESSION-REVOKED`)]
  const host = ['OS-PROFILE', 'ANONYMOUS-DENIED', ...checks, ...revoked].map(item => `${prefix}-${item}`)
  const external = ['DNS', 'TLS', ...checks.filter(item => !hostOnly.includes(item)), ...revoked].map(item => `${prefix}-EXTERNAL-${item}`)
  const browser = ['BROWSER-SIGN-IN', 'BROWSER-PAGE', 'BROWSER-READ', 'BROWSER-SIGNED-OUT'].map(item => `${prefix}-${item}`)
  return Object.freeze({
    toolId: id, inventory: Object.freeze({ unit: Object.freeze(unit.map(item => Object.freeze({ ...item }))), host: Object.freeze(host), browser: Object.freeze(browser), external: Object.freeze(external) }),
    // Each declared account creation brings its operation reads and the time a host takes to provision it.
    driver: Object.freeze({ prefix, as, also, probe, paths: accounts ? new RegExp(`(?:${paths.source})|${ACCOUNT_OPERATION.source}`, paths.flags) : paths, checks, page: Object.freeze(page), run, needs,
      requests: requests + restores.length * 2 + accounts * ACCOUNT_CREATE.requests, deadlineMs: deadlineMs + accounts * ACCOUNT_CREATE.ms, gate, restores, hostOnly, requires_qualification_admission: definition.requires_qualification_admission === true }),
  })
}

/** Stable short name for run-scoped objects, so a rerun with another run ID never meets an earlier run's objects. */
export const runTag = runId => createHash('sha256').update(runId).digest('hex').slice(0, 8)

/** Bounded client for one signed-in session. Session values stay here and never reach evidence. */
export function apiClient(request, session) {
  const send = (method, path, body, extra = {}) => {
    const { noBody, ...rest } = extra
    return request(path, { method, cookie: session.cookie, csrf: session.csrf, ...(noBody || body === undefined ? {} : { body }), ...rest })
  }
  return Object.freeze({
    get: (path, extra) => request(path, { cookie: session.cookie, ...extra }),
    post: (path, body = {}, extra) => send('POST', path, body, extra), put: (path, body, extra) => send('PUT', path, body, extra),
    patch: (path, body, extra) => send('PATCH', path, body, extra), delete: (path, body, extra) => send('DELETE', path, body, extra),
    anonymous: (path, options) => request(path, options),
  })
}

/** One account creation: its POST and operation reads, and the time a lab host takes to provision it (22 to 57 s seen). */
export const ACCOUNT_CREATE = Object.freeze({ requests: 20, ms: 90_000 })
const ACCOUNT_OPERATION = /^\/api\/accounts\/operations\/[0-9a-f-]{36}$/

/**
 * POST /api/accounts, then the API's own job status until the operation ends. A refusal returns the POST answer. An ended
 * operation returns the answer it recorded for the POST (201 body or problem), or its job view after an API restart;
 * `created` is true only for a succeeded operation, and `accepted` holds the 202 answer.
 */
export async function createAccount(client, body, extra, { sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const accepted = await client.post('/api/accounts', body, extra)
  const id = accepted.data?.operation?.id
  // 201 is a creation that settled before its host step (a completed replay); anything else but 202 is a refusal.
  if (accepted.status !== 202 || typeof id !== 'string') return { ...accepted, created: accepted.status === 201 && typeof accepted.data?.account?.id === 'string' }
  let last = accepted
  for (let attempt = 0; attempt < ACCOUNT_CREATE.requests - 2 && ['queued', 'running'].includes(last.data?.operation?.status); attempt++) {
    await sleep(Math.min(5000, 1000 * (attempt + 2)))
    last = await client.get(`/api/accounts/operations/${id}`)
    if (last.status !== 200) break
  }
  const view = last.status === 200 ? last.data : undefined
  if (view?.result !== undefined) return { ...last, status: 201, data: view.result, created: true, accepted }
  if (view?.problem !== undefined) return { ...last, status: view.problem?.status ?? 500, data: view.problem, created: false, accepted }
  return { ...last, created: view?.operation?.status === 'succeeded', accepted }
}

/** Runs one driver: every undo step runs even after a failed check, and a step that cannot confirm removal is a leftover. */
/** Fields that move on every save; what they label must still match after a restore. */
const VOLATILE = /^(?:revision|expectedRevision|authorityRevision|observedAt|.+At)$/
const settled = value => JSON.stringify(value, (key, item) => VOLATILE.test(key) ? undefined : item)

const NOOP_NET = Object.freeze({
  tcpBanner: async () => ({ ok: false, banner: '' }),
  tcpOpen: async () => ({ open: false }),
  tcpConnect: async () => ({ open: false }),
  dnsQuery: async () => ({ ok: false, rcode: 2, authoritative: false, answers: [] }),
  smtpProbe: async () => ({ ok: false, code: 0, banner: '', transcript: [] }),
  smtpExchange: async () => ({ ok: false, code: 0, banner: '', transcript: [] }),
})

export async function runDriver(driver, { clients, prefix = driver.prefix, tag, fixture, site, net: network = NOOP_NET, address = '127.0.0.1', requestFor, host, admitted = true, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const checks = [], undo = [], leftovers = []
  const add = (id, passed, observed) => { checks.push(check(`${prefix}-${id}`, passed, observed)); return passed }
  const block = (id, reason) => { checks.push(blocked(`${prefix}-${id}`, reason)); return false }
  const context = {
    ...clients, tag, fixture, site, net: network, address, host, sleep, check: add, block,
    undo: (label, step) => { undo.unshift({ label, step }) },
    /** A success status, or the check fails with the status and stable code only. */
    ok: (id, response, accepted = [200, 201, 202, 204]) => add(id, accepted.includes(response?.status), safeResponse(response)),
    /** The exact refusal the criterion names, as a stable code, an HTTP status or an accepted list; anything else fails. */
    refused: (id, response, expected) => {
      const match = value => typeof value === 'number' ? response?.status === value : response?.status >= 400 && response?.data?.code === value
      return add(id, Array.isArray(expected) ? expected.some(match) : match(expected), { ...safeResponse(response), expected })
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
    try { await driver.run(context) } catch (error) { failure = `The driver did not complete.${failureCause(error)}` }
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
export async function createFixture(root, { tag, domainSuffix = 'example.net', mailbox = false, sleep }) {
  const username = `xq${tag}`.slice(0, 16), domain = `${username}.${domainSuffix}`, created = {}
  const fixture = { username, domain, accountId: null, password: password(), mailbox: null, cleanup: { ok: false, errors: [] } }
  const need = (response, what) => {
    if (![200, 201].includes(response.status)) throw new Error(`QUALIFICATION_FIXTURE_${what}:${response.status}:${safeResponse(response).code ?? 'none'}`)
    return response.data
  }
  try {
    created.list = need(await root.post('/api/feature-lists', { name: `xq-${tag}`, ownerId: null, disabled: [] }), 'FEATURES').featureList.id
    created.plan = need(await root.post('/api/plans', { name: `xq-${tag}`, featureListId: created.list, resources: { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 } }), 'PLAN').plan.id
    const account = await createAccount(root, { username, password: fixture.password, primaryDomain: domain, planId: created.plan }, { idempotencyKey: `xq-${tag}` }, { sleep })
    // An accepted account is removed with the rest even when its operation did not succeed.
    fixture.accountId = account.data?.account?.id ?? account.accepted?.data?.account?.id ?? null
    if (!account.created) throw new Error(`QUALIFICATION_FIXTURE_ACCOUNT:${account.status}:${safeResponse(account).code ?? account.data?.operation?.status ?? 'none'}`)
    if (typeof fixture.accountId !== 'string') throw new Error('QUALIFICATION_FIXTURE_ACCOUNT_ID')
    if (mailbox) {
      const address = `xq@${domain}`, secret = password()
      need(await root.post('/api/service-users', { accountId: fixture.accountId, login: address, password: secret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 256 }), 'MAILBOX')
      fixture.mailbox = { address, password: secret }
    }
  } catch (error) {
    // The runner reports a removal that was not confirmed as a leftover.
    error.fixtureCleanup = { username, ...await destroyFixture(root, fixture, created) }
    throw error
  }
  fixture.destroy = (actor = root) => destroyFixture(actor, fixture, created)
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

function readDnsName(buf, start) {
  const labels = []
  let pos = start, next = -1, jumps = 0
  while (pos < buf.length && jumps < 20) {
    const len = buf[pos]
    if (len === 0) { if (next === -1) next = pos + 1; break }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break
      if (next === -1) next = pos + 2
      pos = ((len & 0x3f) << 8) | buf[pos + 1]
      jumps++
      continue
    }
    if (pos + 1 + len > buf.length) break
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'))
    pos += 1 + len
  }
  return { name: labels.join('.'), next: next === -1 ? pos + 1 : next }
}

/** Real network client for TCP, UDP DNS and SMTP observations at the reviewed host address. */
export function netClient({ address, deadline }) {
  const timeout = (cap = 4000) => Math.max(1, Math.min(cap, deadline - Date.now()))
  const tcpOpen = port => new Promise(done => {
    const socket = net.createConnection({ host: address, port, timeout: timeout() })
    let settled = false
    const finish = open => { if (settled) return; settled = true; socket.destroy(); done({ open }) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
  const tcpBanner = port => new Promise(done => {
    const socket = net.createConnection({ host: address, port, timeout: timeout() })
    const chunks = []
    let bytes = 0, settled = false, timer = null
    const finish = ok => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      const text = Buffer.concat(chunks).toString('latin1').replace(/[^\x20-\x7e\r\n]+/g, ' ').trim().slice(0, 200)
      done({ ok: ok && text.length > 0, banner: ok ? text : '' })
    }
    socket.on('data', chunk => {
      chunks.push(chunk)
      bytes += chunk.length
      if (chunk.includes(10) || bytes >= 128) finish(true)
      else if (!timer) timer = setTimeout(() => finish(true), 300)
    })
    socket.once('end', () => finish(bytes > 0))
    socket.once('timeout', () => finish(bytes > 0))
    socket.once('error', () => finish(false))
  })
  const dnsQuery = (qname, qtype = 1, port = 53) => new Promise(done => {
    const labels = String(qname ?? '').replace(/\.$/, '').split('.').filter(Boolean)
    if (labels.length === 0 || labels.some(label => Buffer.byteLength(label) > 63)) {
      done({ ok: false, rcode: -1, authoritative: false, answers: [] }); return
    }
    const id = randomBytes(2).readUInt16BE(0)
    const header = Buffer.alloc(12)
    header.writeUInt16BE(id, 0)
    header.writeUInt16BE(0x0000, 2)
    header.writeUInt16BE(1, 4)
    const nameParts = labels.flatMap(label => { const b = Buffer.from(label, 'utf8'); return [Buffer.from([b.length]), b] })
    const tail = Buffer.alloc(5)
    tail.writeUInt8(0, 0)
    tail.writeUInt16BE(qtype, 1)
    tail.writeUInt16BE(1, 3)
    const packet = Buffer.concat([header, ...nameParts, tail])
    const socket = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4')
    let settled = false
    const timer = setTimeout(() => finish({ ok: false, rcode: -1, authoritative: false, answers: [] }), timeout(3000))
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      done(result)
    }
    socket.on('message', msg => {
      if (msg.length < 12 || msg.readUInt16BE(0) !== id) return
      const flags = msg.readUInt16BE(2), rcode = flags & 0x0f, authoritative = (flags & 0x0400) !== 0
      const qdcount = msg.readUInt16BE(4), ancount = msg.readUInt16BE(6)
      let pos = 12
      for (let i = 0; i < qdcount && pos < msg.length; i++) pos = readDnsName(msg, pos).next + 4
      const answers = []
      for (let i = 0; i < ancount && pos + 10 <= msg.length; i++) {
        const owner = readDnsName(msg, pos); pos = owner.next
        if (pos + 10 > msg.length) break
        const type = msg.readUInt16BE(pos), ttl = msg.readUInt32BE(pos + 4), rdlen = msg.readUInt16BE(pos + 8)
        pos += 10
        if (pos + rdlen > msg.length) break
        let data = ''
        if (type === 1 && rdlen === 4) data = `${msg[pos]}.${msg[pos + 1]}.${msg[pos + 2]}.${msg[pos + 3]}`
        else if (type === 16) {
          const parts = []
          for (let off = pos; off < pos + rdlen;) {
            const len = msg[off]
            parts.push(msg.subarray(off + 1, Math.min(pos + rdlen, off + 1 + len)).toString('utf8'))
            off += 1 + len
          }
          data = parts.join('')
        } else if (type === 2 || type === 5 || type === 12) data = readDnsName(msg, pos).name
        else if (type === 15 && rdlen > 2) data = `${msg.readUInt16BE(pos)} ${readDnsName(msg, pos + 2).name}`
        else data = msg.subarray(pos, pos + rdlen).toString('hex')
        pos += rdlen
        answers.push({ name: owner.name, type, ttl, data })
      }
      finish({ ok: true, rcode, authoritative, answers })
    })
    socket.once('error', () => finish({ ok: false, rcode: -1, authoritative: false, answers: [] }))
    socket.send(packet, port, address, err => { if (err) finish({ ok: false, rcode: -1, authoritative: false, answers: [] }) })
  })
  const smtpProbe = (commands = [], port = 25) => new Promise(done => {
    const socket = net.createConnection({ host: address, port, timeout: timeout(5000) })
    const transcript = []
    let buffer = '', current = [], banner = '', lastCode = 0, step = -1, settled = false
    const finish = ok => {
      if (settled) return
      settled = true
      socket.destroy()
      done({ ok, code: lastCode, banner: banner.slice(0, 200), transcript })
    }
    const advance = () => {
      step++
      if (step < commands.length) {
        socket.write(`${commands[step]}\r\n`)
      } else {
        try { socket.write('QUIT\r\n') } catch { /* closing */ }
        finish(banner.length > 0)
      }
    }
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        current.push(line)
        const match = /^(\d{3})(?: (.*))?$/.exec(line)
        if (match) {
          lastCode = Number(match[1])
          const text = current.join(' | ').slice(0, 200)
          current = []
          if (step === -1) banner = text
          else transcript.push(`${lastCode} ${(match[2] ?? '').slice(0, 120)}`)
          advance()
        }
      }
    })
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(banner.length > 0 && step >= commands.length))
  })
  return Object.freeze({ tcpOpen, tcpConnect: tcpOpen, tcpBanner, dnsQuery, smtpProbe, smtpExchange: smtpProbe })
}

/** The other panels live on their paired entry host names (or the same host name when unprefixed) at their own listener ports. */
export const entryOrigin = (origin, port) => {
  const url = new URL(origin)
  if (url.hostname.startsWith('whm.')) {
    const base = url.hostname.slice(4)
    url.hostname = port === 2096 ? `mail.${base}` : port === 2083 ? base : `whm.${base}`
  }
  url.port = String(port)
  return url.origin
}

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
/**
 * The actor's own sign-in form. After a 200 the form navigates to its workspace by itself, so the caller's next
 * navigation waits for that landing; started earlier, it is interrupted by the form's navigation and throws.
 */
export async function signInThroughForm(page, origin, credentials) {
  await page.goto(`${origin}/login?lang=en`)
  await page.locator('#login-username').fill(credentials.username)
  await page.locator('#login-password').fill(credentials.password)
  if (credentials.totpCode !== undefined) await page.locator('#login-otp').fill(credentials.totpCode)
  const [login] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST'),
    page.locator('#login-password').press('Enter'),
  ])
  if (login.status() === 200) await page.waitForURL(url => url.pathname !== '/login', { waitUntil: 'domcontentloaded' })
  return login
}

const SHELL_PATHS = [
  '/api/catalog',
  '/api/auth/me',
  '/api/auth/ui-preferences',
  '/api/ui/preferences',
  '/api/admin/favorites',
  '/api/admin/notifications',
  '/api/whm/favorites',
  '/api/whm/notifications',
  '/api/notifications',
  '/api/account/announcements',
  '/api/server/announcements',
]

export async function pageChecks(driver, { page, origin, credentials }) {
  const { prefix } = driver, checks = [], route = driver.page.route, replies = []
  const readPath = driver.page.read.split('?')[0]
  const isShellPath = pathname => SHELL_PATHS.some(shell => pathname === shell || pathname.startsWith(`${shell}/`))
  const login = await signInThroughForm(page, origin, credentials)
  checks.push(check(`${prefix}-BROWSER-SIGN-IN`, login.status() === 200, { status: login.status() }))
  const onResponse = response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/') && response.status() === 200
      && (!isShellPath(url.pathname) || readPath === url.pathname || readPath.startsWith(`${url.pathname}/`))) {
      replies.push(Promise.race([
        response.json().catch(() => null),
        new Promise(done => setTimeout(() => done(null), 5000).unref()),
      ]))
    }
  }
  page.on('response', onResponse)
  const opened = await page.goto(`${origin}${route}${route.includes('?') ? '&' : '?'}lang=en`)
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  page.off('response', onResponse)
  const closed = await page.locator('[data-tool-availability="unverified"]:not([data-classic-native-security])').count()
  const pageOpen = opened?.status() === 200 && closed === 0
  checks.push(check(`${prefix}-BROWSER-PAGE`, pageOpen, { status: opened?.status() ?? null, route, closedSurfaces: closed, qualificationMode: await page.locator('[data-qualification-mode]').count() === 1 }))
  const read = await page.request.get(`${origin}${driver.page.read}`, { failOnStatusCode: false, maxRedirects: 0, timeout: 15_000 })
  const data = await read.json().catch(() => null), raw = read.status() === 200 ? driver.page.shows?.(data) : undefined
  const text = await page.locator('main').evaluate(main => [main.innerText, ...[...main.querySelectorAll('input, select, textarea')].map(item => item.value)].join('\n')).catch(() => '')
  const captured = await Promise.all(replies)
  const seen = displayValues(readPath === '/api/auth/me' ? captured : [data, ...captured], credentials.username)
  const shown = value => typeof value === 'string' && value.length > 0 && text.includes(value)
  if (driver.page.shows) {
    const expected = Array.isArray(raw) ? raw.filter(value => typeof value === 'string' && value.length > 0) : []
    const passed = read.status() === 200 && (expected.length > 0 ? expected.every(shown) : pageOpen && text.trim().length > 0)
    checks.push(check(`${prefix}-BROWSER-READ`, passed, { status: read.status(), expected: expected.length }))
  } else if (seen.length === 0) {
    checks.push(check(`${prefix}-BROWSER-READ`, read.status() === 200 && pageOpen && text.trim().length > 0, { status: read.status(), compared: 0, matched: 0 }))
  } else {
    checks.push(check(`${prefix}-BROWSER-READ`, read.status() === 200 && seen.some(shown), { status: read.status(), compared: seen.length, matched: seen.filter(shown).length }))
  }
  const [logout] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST'),
    page.evaluate(() => document.querySelector('[data-action="logout"]')?.click()),
  ])
  const revoked = await page.request.get(`${origin}${driver.page.read}`, { failOnStatusCode: false, maxRedirects: 0, timeout: 15_000 })
  const signedOut = logout.status() === 200 && revoked.status() === 401
  checks.push(check(`${prefix}-BROWSER-SIGNED-OUT`, signedOut, { logoutStatus: logout.status(), subsequentRead: revoked.status() }))
  return { checks, signedOut }
}
