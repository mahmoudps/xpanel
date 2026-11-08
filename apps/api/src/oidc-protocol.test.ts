import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { authorizationUrl, exchangeCode, parseDiscovery, parseJwks, pkcePair, verifyIdToken } from './oidc-protocol.ts'

const ISSUER = 'https://id.example.test/realms/main'
const metadata = (patch: Record<string, unknown> = {}) => ({
  issuer: ISSUER, authorization_endpoint: ISSUER + '/auth', token_endpoint: ISSUER + '/token', jwks_uri: ISSUER + '/certs',
  response_types_supported: ['code', 'id_token'], code_challenge_methods_supported: ['plain', 'S256'],
  id_token_signing_alg_values_supported: ['RS256', 'HS256', 'none'], token_endpoint_auth_methods_supported: ['client_secret_basic'], ...patch,
})
const reason = (run: () => unknown): unknown => { try { run(); return 'accepted' } catch (error) { return isXpanelError(error) ? error.detail.reason : error } }

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = (key: KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig' })
const keys = parseJwks({ keys: [jwk(rsa.publicKey, 'r1'), jwk(ec.publicKey, 'e1'), { ...jwk(other.publicKey, 'enc'), use: 'enc' }, { ...rsa.privateKey.export({ format: 'jwk' }), kid: 'private' }] })
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = new Date('2026-11-07T10:00:00Z'), seconds = Math.floor(now.getTime() / 1000)
const claims = (patch: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: 'panel', sub: 'user-1', nonce: 'n-1', exp: seconds + 300, iat: seconds - 5, email: 'a@example.test', ...patch })
const token = (body: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'r1' }, key: KeyObject = rsa.privateKey) => {
  const input = b64(header) + '.' + b64(body)
  const signature = header.alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key)
  return input + '.' + signature.toString('base64url')
}
const verify = (value: string, patch: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(value, { keys, issuer: ISSUER, clientId: 'panel', nonce: 'n-1', algorithms: ['RS256', 'ES256'], now, ...patch })

describe('OIDC discovery', () => {
  it('keeps only the code flow with S256 PKCE and asymmetric signing', () => {
    const discovery = parseDiscovery(metadata(), ISSUER)
    expect(discovery).toMatchObject({ tokenAuth: 'client_secret_basic', algorithms: ['RS256'] })
    expect(reason(() => parseDiscovery(metadata({ issuer: ISSUER + '/' }), ISSUER))).toBe('issuer_mismatch')
    expect(reason(() => parseDiscovery(metadata({ code_challenge_methods_supported: undefined }), ISSUER))).toBe('pkce_unsupported')
    expect(reason(() => parseDiscovery(metadata({ code_challenge_methods_supported: ['plain'] }), ISSUER))).toBe('pkce_unsupported')
    expect(reason(() => parseDiscovery(metadata({ response_types_supported: ['id_token', 'token id_token'] }), ISSUER))).toBe('code_flow_unsupported')
    expect(reason(() => parseDiscovery(metadata({ id_token_signing_alg_values_supported: ['HS256', 'none'] }), ISSUER))).toBe('signing_unsupported')
    expect(reason(() => parseDiscovery(metadata({ token_endpoint: 'http://id.example.test/token' }), ISSUER))).toBe('discovery_invalid')
    expect(parseDiscovery(metadata({ token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_post'] }), ISSUER).tokenAuth).toBe('client_secret_post')
  })

  it('builds an authorization request with state, nonce and an S256 challenge', () => {
    const pair = pkcePair()
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'))
    const url = new URL(authorizationUrl(parseDiscovery(metadata({ authorization_endpoint: ISSUER + '/auth?kc_idp_hint=x' }), ISSUER), { clientId: 'panel', redirectUri: 'https://whm.example.test:2087/api/auth/oidc/callback', state: 's', nonce: 'n', challenge: pair.challenge }))
    expect(Object.fromEntries(url.searchParams)).toEqual({ kc_idp_hint: 'x', response_type: 'code', client_id: 'panel', redirect_uri: 'https://whm.example.test:2087/api/auth/oidc/callback', scope: 'openid email profile', state: 's', nonce: 'n', code_challenge: pair.challenge, code_challenge_method: 'S256' })
  })
})

describe('ID token validation', () => {
  it('accepts a token signed by a published key for this client and nonce', () => {
    expect(keys.map(key => key.kid)).toEqual(['r1', 'e1'])
    expect(verify(token(claims()))).toEqual({ subject: 'user-1', label: 'a@example.test' })
    expect(verify(token(claims(), { alg: 'ES256', kid: 'e1' }, ec.privateKey)).subject).toBe('user-1')
  })

  it('refuses every forged, foreign, stale or replayed token', () => {
    const [head, body] = token(claims()).split('.')
    expect(reason(() => verify(head + '.' + body + '.'))).toBe('id_token_invalid')
    expect(reason(() => verify(b64({ alg: 'none' }) + '.' + body + '.'))).toBe('id_token_algorithm')
    expect(reason(() => verify(token(claims(), { alg: 'HS256', kid: 'r1' })))).toBe('id_token_algorithm')
    expect(reason(() => verify(token(claims(), { alg: 'RS256', kid: 'r1' }, other.privateKey)))).toBe('id_token_signature')
    expect(reason(() => verify(token(claims(), { alg: 'RS256', kid: 'enc' }, other.privateKey)))).toBe('id_token_key_unknown')
    expect(reason(() => verify(token(claims(), { alg: 'RS256', kid: 'r1', jku: 'https://evil.test/keys' })))).toBe('id_token_invalid')
    expect(reason(() => verify(token(claims({ iss: 'https://evil.test' }))))).toBe('id_token_issuer')
    expect(reason(() => verify(token(claims({ aud: 'other' }))))).toBe('id_token_audience')
    expect(reason(() => verify(token(claims({ aud: ['panel', 'other'] }))))).toBe('id_token_audience')
    expect(verify(token(claims({ aud: ['panel', 'other'], azp: 'panel' }))).subject).toBe('user-1')
    expect(reason(() => verify(token(claims({ exp: seconds - 61 }))))).toBe('id_token_expired')
    expect(reason(() => verify(token(claims({ iat: seconds - 3600 }))))).toBe('id_token_time')
    expect(reason(() => verify(token(claims({ nonce: 'n-2' }))))).toBe('id_token_nonce')
    expect(reason(() => verify(token(claims({ sub: '' }))))).toBe('id_token_subject')
    expect(reason(() => verify(token(claims()), { algorithms: ['ES256'] }))).toBe('id_token_algorithm')
    // A JWE has five parts and is never decrypted here.
    expect(reason(() => verify('a.b.c.d.e'))).toBe('id_token_invalid')
  })
})

describe('token exchange', () => {
  it('sends the verifier and form-encoded Basic client credentials, never following redirects', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return new Response(JSON.stringify({ token_type: 'Bearer', id_token: 'x.y.z' })) }
    const discovery = parseDiscovery(metadata(), ISSUER)
    expect(await exchangeCode(fetcher, discovery, { clientId: 'panel id', clientSecret: 'p:w&d', code: 'c', redirectUri: 'https://h/cb', verifier: 'v' })).toBe('x.y.z')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Basic ' + Buffer.from('panel+id:p%3Aw%26d').toString('base64'))
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://h/cb', code_verifier: 'v' })
    const refused = async () => { try { await exchangeCode(async () => new Response('{"error":"invalid_grant"}', { status: 400 }), discovery, { clientId: 'a', clientSecret: 'b', code: 'c', redirectUri: 'https://h/cb', verifier: 'v' }); return 'accepted' } catch (error) { return isXpanelError(error) ? error.detail.reason : error } }
    expect(await refused()).toBe('provider_refused')
  })
})
