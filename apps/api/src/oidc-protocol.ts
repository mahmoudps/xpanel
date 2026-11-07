import { constants, createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { fail } from '@xpanel/core'

/**
 * OpenID Connect relying party for the authorization code flow only (OIDC Core 3.1, RFC 6749, RFC 7636 S256,
 * RFC 9700): discovery, PKCE, state and nonce, a confidential-client token exchange and ID token validation.
 * No implicit or hybrid flow, no unsigned or symmetric ID tokens, no encrypted tokens.
 */

export interface OidcDiscovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  tokenAuth: 'client_secret_basic' | 'client_secret_post'
  algorithms: string[]
}

export interface OidcKey { kid: string | null; alg: string | null; kty: string; crv: string | null; key: KeyObject }
export interface OidcIdentity { subject: string; label: string | null }
export type OidcFetch = (input: string, init?: RequestInit) => Promise<Response>

const ALGORITHMS: Readonly<Record<string, { kty: string; hash: string | null; crv?: string; pss?: true }>> = {
  RS256: { kty: 'RSA', hash: 'sha256' }, RS384: { kty: 'RSA', hash: 'sha384' }, RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true }, PS384: { kty: 'RSA', hash: 'sha384', pss: true }, PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' }, ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' }, ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { kty: 'OKP', hash: null, crv: 'Ed25519' },
}
export const OIDC_ALGORITHMS = Object.keys(ALGORITHMS)
/** Clock tolerance for exp and iat; an ID token older than the flow lifetime is refused. */
const SKEW_SECONDS = 60
const MAX_TOKEN_AGE_SECONDS = 600
const MAX_RESPONSE_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 8000

const unchanged = { stateChanged: false }
const refuse = (reason: string, message: string): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string') ? value as string[] : null

/** An https URL without credentials or fragment; the only form accepted for an issuer or endpoint. */
export const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 512) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !value.includes('#') ? value : null
}

/** An issuer identifier: https, no query or fragment (OIDC Discovery 2). */
export const issuerUrl = (value: unknown): string | null => {
  const url = httpsUrl(value)
  return url && !url.includes('?') && url.length <= 256 ? url : null
}

export const randomToken = (): string => randomBytes(32).toString('base64url')
export const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomToken()
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') }
}

/** OpenID Provider metadata; the issuer must equal the configured one exactly (Discovery 4.3). */
export function parseDiscovery(raw: unknown, expectedIssuer: string): OidcDiscovery {
  if (!object(raw)) return refuse('discovery_invalid', 'the provider metadata is not a JSON object')
  if (raw.issuer !== expectedIssuer) return refuse('issuer_mismatch', 'the provider metadata names a different issuer')
  const authorizationEndpoint = httpsUrl(raw.authorization_endpoint), tokenEndpoint = httpsUrl(raw.token_endpoint), jwksUri = httpsUrl(raw.jwks_uri)
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) return refuse('discovery_invalid', 'the provider endpoints must be https URLs')
  if (!strings(raw.response_types_supported)?.includes('code')) return refuse('code_flow_unsupported', 'the provider does not offer the authorization code flow')
  const grants = raw.grant_types_supported === undefined ? ['authorization_code'] : strings(raw.grant_types_supported)
  if (!grants?.includes('authorization_code')) return refuse('code_flow_unsupported', 'the provider does not offer the authorization code grant')
  // RFC 8414: an absent list means no PKCE support; this client always requires S256.
  if (!strings(raw.code_challenge_methods_supported)?.includes('S256')) return refuse('pkce_unsupported', 'the provider does not advertise PKCE with S256')
  const algorithms = (strings(raw.id_token_signing_alg_values_supported) ?? []).filter(alg => Object.hasOwn(ALGORITHMS, alg))
  if (!algorithms.length) return refuse('signing_unsupported', 'the provider signs ID tokens with no supported asymmetric algorithm')
  const methods = raw.token_endpoint_auth_methods_supported === undefined ? ['client_secret_basic'] : strings(raw.token_endpoint_auth_methods_supported) ?? []
  const tokenAuth = methods.includes('client_secret_basic') ? 'client_secret_basic' as const : methods.includes('client_secret_post') ? 'client_secret_post' as const : null
  if (!tokenAuth) return refuse('client_auth_unsupported', 'the provider accepts no client secret authentication')
  return { issuer: expectedIssuer, authorizationEndpoint, tokenEndpoint, jwksUri, tokenAuth, algorithms }
}

/** Public signing keys of a JWK Set; private, encryption-only and unsupported keys are skipped. */
export function parseJwks(raw: unknown): OidcKey[] {
  if (!object(raw) || !Array.isArray(raw.keys) || raw.keys.length > 64) return refuse('jwks_invalid', 'the provider key set is invalid')
  const keys: OidcKey[] = []
  for (const jwk of raw.keys) {
    if (!object(jwk) || typeof jwk.kty !== 'string' || 'd' in jwk || (jwk.use !== undefined && jwk.use !== 'sig')) continue
    if (jwk.key_ops !== undefined && !strings(jwk.key_ops)?.includes('verify')) continue
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' } as unknown as Parameters<typeof createPublicKey>[0])
      keys.push({ kid: typeof jwk.kid === 'string' ? jwk.kid : null, alg: typeof jwk.alg === 'string' ? jwk.alg : null, kty: jwk.kty, crv: typeof jwk.crv === 'string' ? jwk.crv : null, key })
    } catch { /* an unusable key cannot sign anything this client accepts */ }
  }
  return keys
}

const decodeSegment = (segment: string): Record<string, unknown> => {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return refuse('id_token_invalid', 'the ID token is malformed')
  let value: unknown
  try { value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) } catch { value = null }
  return object(value) ? value : refuse('id_token_invalid', 'the ID token is malformed')
}

const audienceOf = (value: unknown): string[] | null => typeof value === 'string' ? [value] : strings(value)

/** ID token validation of OIDC Core 3.1.3.7 for a code-flow token received directly from the token endpoint. */
export function verifyIdToken(token: unknown, input: { keys: readonly OidcKey[]; issuer: string; clientId: string; nonce: string; algorithms: readonly string[]; now?: Date }): OidcIdentity {
  if (typeof token !== 'string' || token.length > 16 * 1024) return refuse('id_token_invalid', 'the ID token is missing')
  const parts = token.split('.')
  if (parts.length !== 3) return refuse('id_token_invalid', 'encrypted or malformed ID tokens are not accepted')
  const header = decodeSegment(parts[0]!), claims = decodeSegment(parts[1]!)
  const alg = header.alg
  if (typeof alg !== 'string' || !input.algorithms.includes(alg) || !Object.hasOwn(ALGORITHMS, alg)) return refuse('id_token_algorithm', 'the ID token algorithm is not accepted')
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return refuse('id_token_invalid', 'the ID token header carries unsupported key parameters')
  const spec = ALGORITHMS[alg]!
  const kid = typeof header.kid === 'string' ? header.kid : null
  const candidates = input.keys.filter(key => key.kty === spec.kty && (!spec.crv || key.crv === spec.crv) && (key.alg === null || key.alg === alg) && (kid === null || key.kid === kid))
  // Without a kid only a single matching key may be chosen; a wrong guess must never be retried with another key.
  const key = kid === null ? (candidates.length === 1 ? candidates[0] : undefined) : candidates[0]
  if (!key) return refuse('id_token_key_unknown', 'the ID token was signed with an unknown key')
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return refuse('id_token_invalid', 'the ID token is malformed')
  const data = Buffer.from(parts[0] + '.' + parts[1], 'ascii'), signature = Buffer.from(parts[2]!, 'base64url')
  let valid = false
  try {
    valid = spec.kty === 'EC' ? verifySignature(spec.hash, data, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature)
      : spec.pss ? verifySignature(spec.hash, data, { key: key.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature)
        : verifySignature(spec.hash, data, key.key, signature)
  } catch { valid = false }
  if (!valid) return refuse('id_token_signature', 'the ID token signature is invalid')

  if (claims.iss !== input.issuer) return refuse('id_token_issuer', 'the ID token issuer does not match the provider')
  const audience = audienceOf(claims.aud)
  if (!audience?.includes(input.clientId)) return refuse('id_token_audience', 'the ID token is not issued to this panel')
  if ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== input.clientId) return refuse('id_token_audience', 'the ID token is authorized for another party')
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now - SKEW_SECONDS) return refuse('id_token_expired', 'the ID token has expired')
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + SKEW_SECONDS || claims.iat < now - MAX_TOKEN_AGE_SECONDS) return refuse('id_token_time', 'the ID token issue time is not acceptable')
  if (typeof claims.nonce !== 'string' || claims.nonce !== input.nonce) return refuse('id_token_nonce', 'the ID token does not belong to this sign-in')
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(claims.sub)) return refuse('id_token_subject', 'the ID token has no usable subject')
  const label = [claims.email, claims.preferred_username, claims.name].find(value => typeof value === 'string' && value.length > 0 && value.length <= 254 && !/[\u0000-\u001f\u007f]/.test(value)) as string | undefined
  return { subject: claims.sub, label: label ?? null }
}

export function authorizationUrl(discovery: OidcDiscovery, input: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const url = new URL(discovery.authorizationEndpoint)
  for (const [name, value] of [['response_type', 'code'], ['client_id', input.clientId], ['redirect_uri', input.redirectUri], ['scope', 'openid email profile'],
    ['state', input.state], ['nonce', input.nonce], ['code_challenge', input.challenge], ['code_challenge_method', 'S256']] as const) url.searchParams.set(name, value)
  return url.href
}

/** One bounded HTTPS request: no redirects, a time limit and a size limit; never returns a provider error body. */
export async function fetchJson(fetcher: OidcFetch, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } }) }
  catch { return refuse('provider_unreachable', 'the identity provider could not be reached') }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done || !value) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); return refuse('provider_response_invalid', 'the identity provider response is too large') }
    chunks.push(value)
  }
  if (!response.ok) return refuse('provider_refused', `the identity provider answered HTTP ${response.status}`)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return refuse('provider_response_invalid', 'the identity provider response is not JSON') }
}

// RFC 6749 2.3.1: client_secret_basic form-encodes both parts before the Basic encoding.
const formEncode = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+')

export async function exchangeCode(fetcher: OidcFetch, discovery: OidcDiscovery, input: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string }): Promise<unknown> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (discovery.tokenAuth === 'client_secret_basic') headers.authorization = 'Basic ' + Buffer.from(formEncode(input.clientId) + ':' + formEncode(input.clientSecret), 'utf8').toString('base64')
  else { body.set('client_id', input.clientId); body.set('client_secret', input.clientSecret) }
  const result = await fetchJson(fetcher, discovery.tokenEndpoint, { method: 'POST', headers, body: body.toString() })
  if (!object(result) || typeof result.id_token !== 'string') return refuse('token_response_invalid', 'the identity provider returned no ID token')
  if (result.token_type !== undefined && (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer')) return refuse('token_response_invalid', 'the identity provider returned an unexpected token type')
  return result.id_token
}
