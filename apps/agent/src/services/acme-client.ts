import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { AcmeCaClient, AcmeCaClientOrderInput, AcmeCaClientOrderResult, AcmeChallengeTokenMaterial } from './acme.ts'

const ES256 = 'ES256'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface AcmeHttpClientOptions {
  directoryUrl: string
  accountKeyPem?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

interface Directory {
  newNonce: string
  newAccount: string
  newOrder: string
}

interface Jwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

const der = (tag: number, content: Buffer): Buffer => {
  if (content.length < 128) return Buffer.concat([Buffer.from([tag, content.length]), content])
  const length = []
  let n = content.length
  while (n > 0) {
    length.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length, ...length]), content])
}

const derSeq = (items: readonly Buffer[]): Buffer => der(0x30, Buffer.concat(items))
const derSet = (items: readonly Buffer[]): Buffer => der(0x31, Buffer.concat(items))
const derOctet = (content: Buffer): Buffer => der(0x04, content)
const derBit = (content: Buffer): Buffer => der(0x03, Buffer.concat([Buffer.from([0]), content]))
const derUtf8 = (text: string): Buffer => der(0x0c, Buffer.from(text))

const publicJwk = (key: KeyObject): Jwk => {
  const exported = key.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string }
  const x = exported.x
  const y = exported.y
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || x === undefined || y === undefined) {
    return fail('VALIDATION', 'ACME account key must be a P-256 public key')
  }
  return { kty: 'EC', crv: 'P-256', x, y }
}

const thumbprint = (jwk: Jwk): string => createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url')

const signEs256 = (key: KeyObject, input: string): string => {
  const raw = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  if (raw.length !== 64) fail('VALIDATION', 'unexpected ACME signature length')
  return raw.toString('base64url')
}

const csrFor = (names: readonly string[], key: KeyObject): string => {
  const publicKey = createPublicKey(key)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const cn = names[0] ?? fail('VALIDATION', 'a certificate name is required')
  const subject = derSeq([derSet([derSeq([Buffer.from('0603550403', 'hex'), derUtf8(cn)])])])
  const sans = derSeq(names.map(name => der(0x82, Buffer.from(name))))
  const sanExt = derSeq([Buffer.from('0603551d11', 'hex'), derOctet(sans)])
  const extensionRequest = derSeq([
    Buffer.from('06092a864886f70d01090e', 'hex'),
    derSet([derSeq([sanExt])]),
  ])
  const info = derSeq([
    der(0x02, Buffer.from([0])),
    subject,
    spki,
    der(0xa0, Buffer.concat([extensionRequest])),
  ])
  const algorithm = Buffer.from('300a06082a8648ce3d040302', 'hex')
  const signature = sign('sha256', info, key)
  return derSeq([info, algorithm, derBit(signature)]).toString('base64url')
}

const accountKey = (pem?: string): { privateKey: KeyObject; pem: string; jwk: Jwk } => {
  if (pem) {
    const privateKey = createPrivateKey(pem)
    return { privateKey, pem, jwk: publicJwk(createPublicKey(privateKey)) }
  }
  const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const encoded = generated.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const next = typeof encoded === 'string' ? encoded : fail('VALIDATION', 'account key export failed')
  return { privateKey: generated.privateKey, pem: next, jwk: publicJwk(generated.publicKey) }
}

const problem = async (response: Response): Promise<string> => {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { detail?: unknown }
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim()
  } catch { /* use the raw response */ }
  return text.trim() || `ACME request failed with HTTP ${response.status}`
}

/**
 * RFC 8555 client for the certificate adapter. It speaks HTTP-01 only and
 * returns the issued chain plus the matching private key.
 */
export const createHttp01AcmeClient = (options: AcmeHttpClientOptions): AcmeCaClient & { accountKeyPem: string } => {
  const directoryUrl = new URL(options.directoryUrl)
  if (directoryUrl.protocol !== 'https:' && !LOOPBACK.has(directoryUrl.hostname)) {
    fail('VALIDATION', 'ACME directory must be HTTPS except on loopback')
  }
  const transport = options.fetch ?? fetch
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    try {
      return await transport(input, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error'
      return fail('CONFIG_TEST_FAILED', `the certificate authority could not be reached (${message})`)
    }
  }
  const pause = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const key = accountKey(options.accountKeyPem)
  let nonce = ''
  let kid = ''

  const directory = async (): Promise<Directory> => {
    const response = await request(directoryUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) fail('CONFIG_TEST_FAILED', await problem(response))
    const body = await response.json() as Partial<Directory>
    const newNonce = body.newNonce
    const newAccount = body.newAccount
    const newOrder = body.newOrder
    if (!newNonce || !newAccount || !newOrder) return fail('CONFIG_TEST_FAILED', 'ACME directory is missing required endpoints')
    return { newNonce, newAccount, newOrder }
  }

  const refreshNonce = async (url: string): Promise<void> => {
    const response = await request(url, { method: 'HEAD' })
    nonce = response.headers.get('replay-nonce') ?? ''
    if (!nonce) fail('CONFIG_TEST_FAILED', 'ACME server did not provide a nonce')
  }

  const signed = async (url: string, payload: Record<string, unknown> | null, useKid: boolean): Promise<Response> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!nonce) await refreshNonce(url)
      const protectedHeader = {
        alg: ES256,
        nonce,
        url,
        ...(useKid ? { kid } : { jwk: key.jwk }),
      }
      const encodedProtected = b64url(JSON.stringify(protectedHeader))
      const encodedPayload = payload === null ? '' : b64url(JSON.stringify(payload))
      const signature = signEs256(key.privateKey, `${encodedProtected}.${encodedPayload}`)
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json', accept: 'application/json, application/pem-certificate-chain' },
        body: JSON.stringify({ protected: encodedProtected, payload: encodedPayload, signature }),
      })
      nonce = response.headers.get('replay-nonce') ?? ''
      if (response.status !== 400 || attempt === 1) return response
      const detail = await response.clone().text()
      if (!detail.includes('badNonce')) return response
      nonce = ''
    }
    return fail('CONFIG_TEST_FAILED', 'ACME request was not sent')
  }

  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) fail('CONFIG_TEST_FAILED', await problem(response))
    return await response.json() as T
  }

  const client: AcmeCaClient & { accountKeyPem: string } = Object.assign(async (input: AcmeCaClientOrderInput): Promise<AcmeCaClientOrderResult> => {
    if (input.challenge !== 'http-01') return fail('VALIDATION', 'this ACME client issues HTTP-01 certificates only')
    if (input.identifiers.some(name => name.startsWith('*.'))) return fail('VALIDATION', 'HTTP-01 cannot issue a wildcard name')
    const endpoints = await directory()
    if (!nonce) await refreshNonce(endpoints.newNonce)
    const account = await signed(endpoints.newAccount, { termsOfServiceAgreed: true }, false)
    if (!account.ok && account.status !== 200) fail('CONFIG_TEST_FAILED', await problem(account))
    kid = account.headers.get('location') ?? ''
    if (!kid) fail('CONFIG_TEST_FAILED', 'ACME account URL was not returned')
    const orderResponse = await signed(endpoints.newOrder, {
      identifiers: input.identifiers.map(value => ({ type: 'dns', value })),
    }, true)
    const order = await json<{ status: string; authorizations: string[]; finalize: string; certificate?: string }>(orderResponse)
    const orderUrl = orderResponse.headers.get('location') ?? ''
    if (!orderUrl || !Array.isArray(order.authorizations) || !order.finalize) fail('CONFIG_TEST_FAILED', 'ACME order response is incomplete')

    const challenges: AcmeChallengeTokenMaterial[] = []
    const challengeUrls: string[] = []
    for (const authorizationUrl of order.authorizations) {
      const authorization = await json<{ identifier: { value: string }; challenges: { type: string; url: string; token: string; status: string }[] }>(await signed(authorizationUrl, null, true))
      const http01 = authorization.challenges.find(item => item.type === 'http-01')
      if (!http01) return fail('CONFIG_TEST_FAILED', `no HTTP-01 challenge was offered for ${authorization.identifier.value}`)
      challenges.push({
        identifier: authorization.identifier.value,
        token: http01.token,
        keyAuthorization: `${http01.token}.${thumbprint(key.jwk)}`,
      })
      challengeUrls.push(http01.url)
    }
    await input.onPublishChallenges(challenges)
    for (const url of challengeUrls) {
      const response = await signed(url, {}, true)
      if (!response.ok) fail('CONFIG_TEST_FAILED', await problem(response))
    }
    for (const authorizationUrl of order.authorizations) {
      let status = 'pending'
      for (let attempt = 0; attempt < 40 && status !== 'valid'; attempt += 1) {
        const authorization = await json<{ status: string; challenges?: { error?: { detail?: string } }[] }>(await signed(authorizationUrl, null, true))
        status = authorization.status
        if (status === 'invalid') {
          const detail = authorization.challenges?.map(item => item.error?.detail).find(Boolean)
          fail('CONFIG_TEST_FAILED', detail || 'HTTP-01 validation failed')
        }
        if (status !== 'valid') await pause(2_000)
      }
      if (status !== 'valid') fail('CONFIG_TEST_FAILED', 'HTTP-01 validation did not complete')
    }

    const issuedKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const finalized = await signed(order.finalize, { csr: csrFor(input.identifiers, issuedKey.privateKey) }, true)
    if (!finalized.ok) fail('CONFIG_TEST_FAILED', await problem(finalized))
    let certificateUrl = ''
    for (let attempt = 0; attempt < 40 && !certificateUrl; attempt += 1) {
      const current = await json<{ status: string; certificate?: string }>(await signed(orderUrl, null, true))
      if (current.status === 'invalid') fail('CONFIG_TEST_FAILED', 'ACME order failed after validation')
      if (current.status === 'valid' && current.certificate) certificateUrl = current.certificate
      else await pause(2_000)
    }
    if (!certificateUrl) fail('CONFIG_TEST_FAILED', 'ACME order did not produce a certificate')
    const certificate = await signed(certificateUrl, null, true)
    if (!certificate.ok) fail('CONFIG_TEST_FAILED', await problem(certificate))
    const fullchainPem = await certificate.text()
    const exported = issuedKey.privateKey.export({ type: 'pkcs8', format: 'pem' })
    return {
      orderUrl,
      fullchainPem,
      privkeyPem: typeof exported === 'string' ? exported : fail('VALIDATION', 'certificate key export failed'),
    }
  }, { accountKeyPem: key.pem })
  return client
}
