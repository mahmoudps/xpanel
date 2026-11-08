import { createHash, generateKeyPairSync, sign } from 'node:crypto'

export const ISSUER = 'https://id.example.test'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A minimal OpenID provider: discovery, keys and a token endpoint that checks the PKCE verifier and the client secret. */
export function oidcTestProvider() {
  const idp = { subject: 'person-1', challenge: '', nonce: '', tokenCalls: 0, refuse: false }
  const fetcher = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url === ISSUER + '/.well-known/openid-configuration') return Response.json({ issuer: ISSUER, authorization_endpoint: ISSUER + '/authorize', token_endpoint: ISSUER + '/token', jwks_uri: ISSUER + '/keys',
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] })
    if (url === ISSUER + '/keys') return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] })
    if (url === ISSUER + '/token') {
      idp.tokenCalls++
      const form = new URLSearchParams(String(init.body))
      const basic = (init.headers as Record<string, string>).authorization
      if (idp.refuse || basic !== 'Basic ' + Buffer.from('panel:s3cret').toString('base64') || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== idp.challenge)
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const seconds = Math.floor(Date.now() / 1000), header = b64({ alg: 'RS256', kid: 'k1' })
      const body = b64({ iss: ISSUER, aud: 'panel', sub: idp.subject, nonce: idp.nonce, iat: seconds, exp: seconds + 300, email: 'admin@example.test' })
      return Response.json({ token_type: 'Bearer', id_token: `${header}.${body}.${sign('sha256', Buffer.from(header + '.' + body), keys.privateKey).toString('base64url')}` })
    }
    return new Response('not found', { status: 404 })
  }
  return { idp, fetcher }
}
