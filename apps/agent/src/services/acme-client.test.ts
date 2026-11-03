import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createHttp01AcmeClient } from './acme-client.ts'

const TOKEN = 'token1234567890ab'
const CHAIN = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

const startDirectory = async () => {
  const published: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    if (req.method === 'GET' && url === '/directory') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` }))
      return
    }
    if (url === '/nonce') {
      res.setHeader('replay-nonce', 'nonce-1')
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const message = raw ? JSON.parse(raw) as { payload?: string } : {}
      const payload = message.payload ? JSON.parse(Buffer.from(message.payload, 'base64url').toString('utf8')) as Record<string, unknown> : null
      res.setHeader('replay-nonce', 'nonce-2')
      if (url === '/account') {
        res.statusCode = 201
        res.setHeader('location', `${base}/acct/1`)
        res.end('{}')
        return
      }
      if (url === '/order' && payload && Array.isArray(payload.identifiers)) {
        res.statusCode = 201
        res.setHeader('location', `${base}/order/1`)
        res.end(JSON.stringify({ status: 'pending', authorizations: [`${base}/authz/1`], finalize: `${base}/finalize` }))
        return
      }
      if (url === '/authz/1' && payload === null) {
        res.end(JSON.stringify({
          status: published.length ? 'valid' : 'pending',
          identifier: { type: 'dns', value: 'example.com' },
          challenges: [{ type: 'http-01', status: 'pending', url: `${base}/chal/1`, token: TOKEN }],
        }))
        return
      }
      if (url === '/chal/1') {
        published.push(TOKEN)
        res.end(JSON.stringify({ status: 'pending' }))
        return
      }
      if (url === '/finalize' || url === '/order/1') {
        res.end(JSON.stringify({ status: 'valid', certificate: `${base}/cert/1` }))
        return
      }
      if (url === '/cert/1') {
        res.setHeader('content-type', 'application/pem-certificate-chain')
        res.end(CHAIN)
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${url}` }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/directory`,
    published,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('in-repo HTTP-01 ACME client', () => {
  it('asks the CA to validate only after the challenge is published', async () => {
    const directory = await startDirectory()
    try {
      const client = createHttp01AcmeClient({ directoryUrl: directory.url, sleep: async () => undefined })
      let published = ''
      const result = await client({
        certId: '11111111-1111-4111-8111-111111111111',
        identifiers: ['example.com'],
        challenge: 'http-01',
        directoryUrl: directory.url,
        onPublishChallenges: async challenges => {
          published = challenges[0]?.keyAuthorization ?? ''
          expect(directory.published).toEqual([])
        },
      })
      expect(published.startsWith(`${TOKEN}.`)).toBe(true)
      expect(published.split('.')[1]).toHaveLength(43)
      expect(directory.published).toEqual([TOKEN])
      expect(result.fullchainPem).toBe(CHAIN)
      expect(result.privkeyPem).toContain('BEGIN PRIVATE KEY')
    } finally {
      await directory.close()
    }
  })

  it('surfaces the CA problem detail', async () => {
    const client = createHttp01AcmeClient({
      directoryUrl: 'http://127.0.0.1/directory',
      fetch: async () => new Response(JSON.stringify({ detail: 'The ACME account could not be created.' }), { status: 403, headers: { 'content-type': 'application/problem+json' } }),
    })
    await expect(client({
      certId: '11111111-1111-4111-8111-111111111111',
      identifiers: ['example.com'],
      challenge: 'http-01',
      directoryUrl: 'http://127.0.0.1/directory',
      onPublishChallenges: async () => undefined,
    })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: 'The ACME account could not be created.', detail: { reason: 'certificate_authority_rejected' } })
  })
})

// Portable CA responses only: no external authority or native hosting is exercised.
const refusalInput = {
  certId: '11111111-1111-4111-8111-111111111111', identifiers: ['example.com'], challenge: 'http-01' as const,
  directoryUrl: 'https://ca.example/directory', onPublishChallenges: async () => undefined,
}
const caRefusalTransport = (at: 'order' | 'challenge' | 'finalize' | 'settled-order', reason: string): typeof fetch => {
  let challenged = false
  const json = (body: unknown, status = 200, location?: string) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'replay-nonce': 'synthetic-nonce', ...(location ? { location } : {}) },
  })
  return async input => {
    const path = new URL(String(input)).pathname
    if (path === '/directory') return json({ newNonce: 'https://ca.example/nonce', newAccount: 'https://ca.example/account', newOrder: 'https://ca.example/order' })
    if (path === '/nonce') return new Response(null, { headers: { 'replay-nonce': 'synthetic-nonce' } })
    if (path === '/account') return json({}, 201, 'https://ca.example/account/1')
    if (path === '/order') return at === 'order' ? json({ detail: reason }, 429) : json({ status: 'pending', authorizations: ['https://ca.example/authorization'], finalize: 'https://ca.example/finalize' }, 201, 'https://ca.example/order/1')
    if (path === '/authorization') return json({ status: challenged ? at === 'challenge' ? 'invalid' : 'valid' : 'pending', identifier: { value: 'example.com' },
      challenges: [{ type: 'http-01', url: 'https://ca.example/challenge', token: TOKEN, status: 'pending', ...(challenged && at === 'challenge' ? { error: { detail: reason } } : {}) }] })
    if (path === '/challenge') { challenged = true; return json({ status: 'pending' }) }
    if (path === '/finalize') return at === 'finalize' ? json({ detail: reason }, 403) : json({ status: 'processing' })
    if (path === '/order/1' && at === 'settled-order') return json({ status: 'invalid', error: { detail: reason } })
    throw new Error('unexpected portable CA request')
  }
}

describe('CA rejection classification', () => {
  it.each(['order', 'challenge', 'finalize', 'settled-order'] as const)('retains the actual reason from a terminal %s rejection', async at => {
    const reason = 'While processing CAA for example.com: SERVFAIL looking up CAA for example.com'
    const client = createHttp01AcmeClient({ directoryUrl: refusalInput.directoryUrl, fetch: caRefusalTransport(at, reason), sleep: async () => undefined })
    await expect(client(refusalInput)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: reason, detail: { reason: 'certificate_authority_rejected' } })
  })
  it('bounds and redacts a structured CA detail while never exposing a raw response body', async () => {
    const hidden = 's'.repeat(40)
    const client = (body: string) => createHttp01AcmeClient({ directoryUrl: refusalInput.directoryUrl, fetch: async () => new Response(body, { status: 403 }) })
    const error = await client(JSON.stringify({ detail: 'CAA refused. token=' + hidden + '\n' + 'x'.repeat(5000) }))(refusalInput).catch(error => error)
    expect(error.message).toContain('CAA refused. token=[REDACTED]')
    expect(error.message).not.toContain(hidden); expect(error.message).not.toContain('\n')
    expect(error.message.length).toBeLessThanOrEqual(526)
    const raw = await client('<html>proxy diagnostic ' + hidden + '</html>')(refusalInput).catch(error => error)
    expect(raw.message).toBe('ACME request failed with HTTP 403')
    expect(JSON.stringify(raw)).not.toContain(hidden)
  })
  it('classifies authority transport failure distinctly from rejection without disclosing the exception text', async () => {
    const hidden = 's'.repeat(40)
    const client = createHttp01AcmeClient({ directoryUrl: refusalInput.directoryUrl, fetch: async () => { throw new Error('Authorization: Bearer ' + hidden) } })
    const error = await client(refusalInput).catch(error => error)
    expect(error.message).toBe('the certificate authority could not be reached')
    expect(error.detail).toEqual({ reason: 'certificate_authority_unreachable' }); expect(JSON.stringify(error)).not.toContain(hidden)
  })
})
