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
    })).rejects.toMatchObject({ message: 'The ACME account could not be created.' })
  })
})
