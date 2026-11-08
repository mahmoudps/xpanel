import https from 'node:https'
import { isIP } from 'node:net'
import { requireValue } from './contracts.mjs'
import { pinnedLookup, validateServerInformationOrigin } from './server-information-contract.mjs'

const SERVER_INFORMATION_PATHS = ['/api/server/info', '/api/auth/login', '/api/auth/logout']

/** Normal TLS verification, fixed local address and no redirects/retries or forwarded-auth headers. */
export function createQualificationTransport({ origin, address, ca, deadline, allow = path => SERVER_INFORMATION_PATHS.includes(path), maxRequests = 8, methods = ['GET', 'POST'], maxBody = 16 * 1024, acceptText = false }) {
  const normalizedOrigin = validateServerInformationOrigin(origin), base = new URL(normalizedOrigin)
  const family = isIP(address)
  requireValue(family !== 0 && Number.isFinite(deadline), 'A measured local HTTPS address and deadline are required')
  let requests = 0
  return async (pathname, { method = 'GET', body, cookie, csrf, forged = false, idempotencyKey, bearer, basic } = {}) => {
    requireValue(allow(pathname) && methods.includes(method) && ++requests <= maxRequests, 'Qualification request exceeds the bounded endpoint inventory')
    const timeout = Math.min(5000, deadline - Date.now())
    requireValue(timeout > 0, 'Qualification deadline expired')
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    requireValue(bytes === undefined || bytes.length <= maxBody, 'Qualification authentication payload exceeded bounds')
    return new Promise((resolveResponse, reject) => {
      const request = https.request({
        protocol: 'https:', hostname: base.hostname, port: base.port || 443, servername: isIP(base.hostname) === 0 ? base.hostname : undefined,
        path: pathname, method, rejectUnauthorized: true, lookup: pinnedLookup(address, family), agent: false,
        ...(ca === undefined ? {} : { ca }),
        headers: {
          accept: 'application/json', origin: normalizedOrigin, 'user-agent': 'xpanel-server-information-qualification/1',
          ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }),
          ...(cookie === undefined ? {} : { cookie }), ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }), ...(basic === undefined ? {} : { authorization: `Basic ${Buffer.from(basic).toString('base64')}` }),
          ...(forged ? { 'x-xpanel-principal-id': 'qualification-forged-principal', 'x-xpanel-caller-role': 'root' } : {}),
        },
      }, response => {
        const chunks = []; let length = 0
        const timer = setTimeout(() => request.destroy(new Error('QUALIFICATION_HTTP_DEADLINE')), timeout)
        response.on('data', chunk => {
          length += chunk.length
          if (length > 2 * 1024 * 1024) { request.destroy(new Error('QUALIFICATION_HTTP_SIZE')); return }
          chunks.push(chunk)
        })
        response.on('end', () => {
          clearTimeout(timer)
          try {
            requireValue(response.statusCode !== undefined && (response.statusCode < 300 || response.statusCode >= 400), 'Redirects are not qualification evidence')
            const raw = Buffer.concat(chunks), text = raw.toString('utf8')
            const type = response.headers['content-type'] ?? '', textual = acceptText && !/json/i.test(type)
            const data = text.length === 0 || textual ? null : JSON.parse(text)
            resolveResponse({ status: response.statusCode, data, setCookie: response.headers['set-cookie'] ?? [], contentType: type, ...(textual ? { text } : {}) })
          } catch { reject(new Error('QUALIFICATION_HTTP_INVALID_RESPONSE')) }
        })
        response.on('error', () => { clearTimeout(timer); reject(new Error('QUALIFICATION_HTTP_RESPONSE_FAILED')) })
      })
      const timer = setTimeout(() => request.destroy(new Error('QUALIFICATION_HTTP_DEADLINE')), timeout)
      request.once('socket', socket => socket.once('secureConnect', () => {
        const remote = socket.remoteAddress?.replace(/^::ffff:/, '')
        if (remote !== address.replace(/^::ffff:/, '')) request.destroy(new Error('QUALIFICATION_HTTP_REMOTE_MISMATCH'))
      }))
      request.once('error', () => { clearTimeout(timer); reject(new Error('QUALIFICATION_HTTP_TRANSPORT_FAILED')) })
      request.once('close', () => clearTimeout(timer))
      request.end(bytes)
    })
  }
}

/** Cookie/CSRF values stay inside the runner and are never included in evidence. */
export function authenticatedSession(response, entryPoint = 'xwhm') {
  requireValue(response.status === 200 && response.data?.principal?.kind === (entryPoint === 'xwhm' ? 'root' : 'user') && response.data?.entryPoint === entryPoint && typeof response.data?.csrfToken === 'string' && response.data.csrfToken.length > 0 && response.data.csrfToken.length <= 4096 && response.data.passwordChangeRequired === false, 'A normal fully authenticated xWHM root session is required')
  const candidates = response.setCookie.filter(value => new RegExp(`^__Host-${entryPoint}_session=[A-Za-z0-9_-]+;`).test(value))
  requireValue(candidates.length === 1 && /;\s*Secure(?:;|$)/i.test(candidates[0]) && /;\s*HttpOnly(?:;|$)/i.test(candidates[0]) && /;\s*SameSite=Strict(?:;|$)/i.test(candidates[0]) && /;\s*Path=\/(?:;|$)/i.test(candidates[0]) && !/;\s*Domain=/i.test(candidates[0]), 'A secure audience-bound root session cookie is required')
  return { cookie: candidates[0].split(';')[0], csrf: response.data.csrfToken }
}
