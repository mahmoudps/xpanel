import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dnsClusterPinnedCall, dnsClusterSpkiPin, DnsClusterTransportError } from './dns-cluster-transport.ts'

const TOKEN = 'xpdc_' + 'c'.repeat(43)
let dir = '', key = '', cert = '', otherCert = ''
const pair = (name: string): { key: string; cert: string } => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=peer.test', '-days', '2', '-keyout', join(dir, name + '.key'), '-out', join(dir, name + '.crt')], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, name + '.key'), 'utf8'), cert: readFileSync(join(dir, name + '.crt'), 'utf8') }
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'xp-dns-tls-'))
  const main = pair('main'), other = pair('other')
  key = main.key; cert = main.cert; otherCert = other.cert
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let server: Server | null = null
afterEach(() => { server?.closeAllConnections(); server?.close(); server = null })
const seen: { authorization?: string; host?: string; body: string }[] = []
const listen = async (handler?: () => void): Promise<number> => {
  seen.length = 0
  server = createServer({ key, cert }, (request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push({ ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(request.headers.host ? { host: request.headers.host } : {}), body })
      if (handler) { handler(); return }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, method: request.method, url: request.url }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
const endpoint = (port: number, pin = dnsClusterSpkiPin(cert)) => ({ name: 'peer.test', address: '127.0.0.1', port, pin, token: TOKEN })

describe('pinned cluster transport', () => {
  it('calls a member over TLS when its key matches the pin, self-signed or not', async () => {
    const port = await listen()
    await expect(dnsClusterPinnedCall(endpoint(port), { method: 'PUT', path: '/api/cluster/dns/zones/a.test', body: { serial: 1 } })).resolves.toEqual({ status: 200, body: { ok: true, method: 'PUT', url: '/api/cluster/dns/zones/a.test' } })
    expect(seen).toEqual([{ authorization: 'Bearer ' + TOKEN, host: `peer.test:${port}`, body: '{"serial":1}' }])
  })
  it('stops at a different key and never sends the token', async () => {
    const port = await listen()
    await expect(dnsClusterPinnedCall(endpoint(port, dnsClusterSpkiPin(otherCert)), { method: 'GET', path: '/api/cluster/dns/hello' })).rejects.toMatchObject({ kind: 'pin_mismatch' })
    expect(seen).toEqual([])
  })
  it('keeps the pin across a new certificate for the same key', () => {
    execFileSync('openssl', ['req', '-x509', '-new', '-key', join(dir, 'main.key'), '-subj', '/CN=renewed.test', '-days', '3', '-out', join(dir, 'renewed.crt')], { stdio: 'ignore' })
    expect(dnsClusterSpkiPin(readFileSync(join(dir, 'renewed.crt'), 'utf8'))).toBe(dnsClusterSpkiPin(cert))
    expect(dnsClusterSpkiPin(otherCert)).not.toBe(dnsClusterSpkiPin(cert))
  })
  it('reports a closed port as unreachable', async () => {
    const closed = createTcpServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise(resolve => closed.close(resolve))
    await expect(dnsClusterPinnedCall(endpoint(port), { method: 'GET', path: '/x' })).rejects.toBeInstanceOf(DnsClusterTransportError)
    await expect(dnsClusterPinnedCall(endpoint(port), { method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'unreachable' })
  })
  it('gives up on a member that accepts and never answers', async () => {
    const port = await listen(() => undefined)
    await expect(dnsClusterPinnedCall(endpoint(port), { method: 'GET', path: '/x', timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' })
  })
})
