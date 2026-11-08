import { createHash, X509Certificate } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'

export interface DnsClusterEndpoint { name: string; address: string; port: number; pin: string; token: string }
export interface DnsClusterRequest { method: 'GET' | 'PUT' | 'DELETE' | 'POST'; path: string; body?: unknown; timeoutMs?: number }
export interface DnsClusterResponse { status: number; body: unknown }
export type DnsClusterCall = (endpoint: DnsClusterEndpoint, request: DnsClusterRequest) => Promise<DnsClusterResponse>
export type DnsClusterTransportFailure = 'pin_mismatch' | 'unreachable' | 'timeout' | 'tls_failed' | 'bad_response'
export class DnsClusterTransportError extends Error {
  readonly kind: DnsClusterTransportFailure
  constructor(kind: DnsClusterTransportFailure) { super('dns_cluster_' + kind); this.kind = kind }
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** SHA-256 of the DER SubjectPublicKeyInfo, so a renewal that keeps the key keeps the pin. */
export const dnsClusterSpkiPin = (certificate: string | Buffer): string =>
  createHash('sha256').update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

/**
 * One HTTP/1.1 request over TLS to the saved address. The token is written only after the peer key matched the pin:
 * the handshake finishes first, and the request is created on the checked socket.
 */
export const dnsClusterPinnedCall: DnsClusterCall = (endpoint, request) => new Promise((resolve, reject) => {
  let settled = false, socket: TLSSocket | null = null
  const finish = (error: Error | null, value?: DnsClusterResponse): void => {
    if (settled) return
    settled = true; clearTimeout(timer); socket?.destroy()
    if (error) reject(error); else resolve(value!)
  }
  const timer = setTimeout(() => finish(new DnsClusterTransportError('timeout')), request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // Chain trust is off on purpose: a self-signed member is normal, and the pin is stricter than any CA.
  socket = tlsConnect({ host: endpoint.address, port: endpoint.port, ...(isIP(endpoint.name) ? {} : { servername: endpoint.name }), rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
  socket.on('error', error => {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    finish(new DnsClusterTransportError(/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code) ? 'unreachable' : code === 'ETIMEDOUT' ? 'timeout' : 'tls_failed'))
  })
  socket.once('secureConnect', () => {
    const tls = socket!
    let pin: string | null = null
    try { const raw = tls.getPeerCertificate().raw; pin = raw ? dnsClusterSpkiPin(raw) : null } catch { pin = null }
    if (pin !== endpoint.pin) { finish(new DnsClusterTransportError('pin_mismatch')); return }
    const payload = request.body === undefined ? null : Buffer.from(JSON.stringify(request.body))
    const outgoing = httpRequest({
      createConnection: () => tls, host: endpoint.name, port: endpoint.port, method: request.method, path: request.path,
      headers: { host: endpoint.port === 443 ? endpoint.name : `${endpoint.name}:${endpoint.port}`, authorization: 'Bearer ' + endpoint.token, accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) finish(new DnsClusterTransportError('bad_response')); else chunks.push(chunk) })
      response.on('error', () => finish(new DnsClusterTransportError('unreachable')))
      response.on('end', () => {
        let body: unknown = null
        try { body = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { finish(new DnsClusterTransportError('bad_response')); return }
        finish(null, { status: response.statusCode ?? 0, body })
      })
    })
    outgoing.on('error', () => finish(new DnsClusterTransportError('unreachable')))
    outgoing.end(payload ?? undefined)
  })
})
