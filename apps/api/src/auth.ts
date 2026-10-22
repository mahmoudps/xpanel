import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  MIN_ARGON2_MEMORY_KIB,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  assertArgon2Hash,
  cidrContains,
  fail,
  parseCidr,
  parseIp,
} from '@xpanel/core'
import type { Principal } from '@xpanel/core'
import {
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  getPrincipal,
  touchSession,
} from '@xpanel/db'
import type { Db, PrincipalRecord } from '@xpanel/db'

export const SESSION_COOKIE_NAME = 'xpanel_session'
export const HOST_SESSION_COOKIE_NAME = '__Host-xpanel_session'
export const CSRF_HEADER_NAME = 'x-csrf-token'
export { SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_TIMEOUT_MS } from '@xpanel/core'
export const MAX_PASSWORD_DERIVATIONS = 1
export const MAX_PENDING_PASSWORD_DERIVATIONS = 16

const MAX_PASSWORD_BYTES = 1024
const MAX_ARGON2_MEMORY_KIB = 131_072
const MAX_ARGON2_PASSES = 6
const MAX_ARGON2_PARALLELISM = 4

const ARGON2ID_PARSE_RE =
  /^\$argon2id\$v=19\$m=([1-9][0-9]{0,9}),t=([1-9][0-9]{0,9}),p=([1-9][0-9]{0,2})\$([A-Za-z0-9+/]{1,86})\$([A-Za-z0-9+/]{1,86})$/

const toUnpaddedBase64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '')

interface PasswordParameters {
  salt: Buffer
  memoryKiB: number
  timeCost: number
  parallelism: number
}

const validPassword = (password: string): boolean =>
  typeof password === 'string' &&
  password.length > 0 &&
  !password.includes('\0') &&
  Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES

const validCosts = ({ memoryKiB, timeCost, parallelism }: PasswordParameters): boolean =>
  Number.isSafeInteger(memoryKiB) && memoryKiB >= MIN_ARGON2_MEMORY_KIB && memoryKiB <= MAX_ARGON2_MEMORY_KIB &&
  Number.isSafeInteger(timeCost) && timeCost >= 1 && timeCost <= MAX_ARGON2_PASSES &&
  Number.isSafeInteger(parallelism) && parallelism >= 1 && parallelism <= MAX_ARGON2_PARALLELISM

let activePasswordDerivations = 0
const pendingPasswordDerivations: Array<() => void> = []

export interface PasswordDerivationStats {
  active: number
  pending: number
  maxActive: number
  maxPending: number
}

export const getPasswordDerivationStats = (): PasswordDerivationStats => ({
  active: activePasswordDerivations,
  pending: pendingPasswordDerivations.length,
  maxActive: MAX_PASSWORD_DERIVATIONS,
  maxPending: MAX_PENDING_PASSWORD_DERIVATIONS,
})

// One native asynchronous KDF at a time reserves at most 128 MiB for password work.
// A bounded queue prevents a login burst from exhausting the 1 GB host budget.
const deriveArgon2idDigest = (password: string, params: PasswordParameters, tagLength: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const run = (): void => {
      activePasswordDerivations++
      const finish = (error: unknown, digest?: Buffer): void => {
        activePasswordDerivations--
        pendingPasswordDerivations.shift()?.()
        if (error) reject(error)
        else resolve(digest!)
      }
      try {
        argon2('argon2id', {
          message: password,
          nonce: params.salt,
          memory: params.memoryKiB,
          passes: params.timeCost,
          parallelism: params.parallelism,
          tagLength,
        }, finish)
      } catch (error) {
        finish(error)
      }
    }
    if (activePasswordDerivations < MAX_PASSWORD_DERIVATIONS) run()
    else if (pendingPasswordDerivations.length < MAX_PENDING_PASSWORD_DERIVATIONS) pendingPasswordDerivations.push(run)
    else fail('SERVICE_UNAVAILABLE', 'password derivation capacity reached; retry later')
  })

/** Produces an interoperable RFC 9106 Argon2id PHC using the platform's asynchronous native implementation. */
export const hashPasswordArgon2id = async (
  password: string,
  opts?: { memoryKiB?: number; timeCost?: number; parallelism?: number; salt?: Buffer },
): Promise<string> => {
  if (!validPassword(password)) {
    fail('VALIDATION', `password must contain 1..${MAX_PASSWORD_BYTES} UTF-8 bytes`)
  }
  const params: PasswordParameters = {
    memoryKiB: opts?.memoryKiB ?? MIN_ARGON2_MEMORY_KIB,
    timeCost: opts?.timeCost ?? 3,
    parallelism: opts?.parallelism ?? 4,
    salt: opts?.salt ?? randomBytes(16),
  }
  if (!validCosts(params)) {
    fail('VALIDATION', `argon2id costs must be m=${MIN_ARGON2_MEMORY_KIB}..${MAX_ARGON2_MEMORY_KIB}, t=1..${MAX_ARGON2_PASSES}, p=1..${MAX_ARGON2_PARALLELISM}`)
  }
  if (!Buffer.isBuffer(params.salt) || params.salt.byteLength < 16 || params.salt.byteLength > 64) {
    fail('VALIDATION', 'argon2id salt must be 16..64 bytes')
  }
  params.salt = Buffer.from(params.salt)
  const digest = await deriveArgon2idDigest(password, params, 32)
  const encoded = `$argon2id$v=19$m=${params.memoryKiB},t=${params.timeCost},p=${params.parallelism}$${toUnpaddedBase64(params.salt)}$${toUnpaddedBase64(digest)}`
  return assertArgon2Hash(encoded)
}

const parsePasswordHashArgon2id = (encodedHash: unknown): { params: PasswordParameters; expected: Buffer } | null => {
  if (typeof encodedHash !== 'string' || encodedHash.length > 512) {
    return null
  }
  const match = ARGON2ID_PARSE_RE.exec(encodedHash)
  if (!match) return null
  const params: PasswordParameters = {
    memoryKiB: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
    salt: Buffer.from(match[4]!, 'base64'),
  }
  const expected = Buffer.from(match[5]!, 'base64')
  if (!validCosts(params) || params.salt.byteLength < 16 || params.salt.byteLength > 64 ||
      expected.byteLength < 32 || expected.byteLength > 64 ||
      toUnpaddedBase64(params.salt) !== match[4] || toUnpaddedBase64(expected) !== match[5]) {
    return null
  }
  return { params, expected }
}

/** Validates a supplied credential without trusting its label or allocating its requested KDF memory. */
export const assertPasswordHashArgon2id = (encodedHash: unknown): string => {
  if (!parsePasswordHashArgon2id(encodedHash)) fail('VALIDATION', 'password hash must use supported Argon2id parameters and canonical encoding')
  return encodedHash as string
}

/** Provisions exactly the supplied credential; missing passwords never acquire a shared default. */
export const passwordHashFromInput = async (
  input: { password?: unknown; passwordHash?: unknown },
  opts: { service?: boolean } = {},
): Promise<string> => {
  if (input.password !== undefined && input.passwordHash !== undefined) {
    fail('VALIDATION', 'supply a password or passwordHash, not both')
  }
  let hash: string
  if (input.passwordHash !== undefined) {
    const encoded = input.passwordHash
    if (opts.service) {
      if (typeof encoded !== 'string' || !encoded.startsWith('{ARGON2ID}')) {
        return fail('VALIDATION', 'service passwordHash must use the {ARGON2ID} scheme')
      }
      hash = assertPasswordHashArgon2id(encoded.slice('{ARGON2ID}'.length))
    } else {
      hash = assertPasswordHashArgon2id(encoded)
    }
  } else {
    if (typeof input.password !== 'string' || input.password.length < 8) {
      return fail('VALIDATION', 'password must contain at least 8 characters')
    }
    if (
      input.password.includes('\0') ||
      /[\r\n]/.test(input.password) ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      return fail('VALIDATION', `password must be a single line of 8..${MAX_PASSWORD_BYTES} UTF-8 bytes`)
    }
    hash = await hashPasswordArgon2id(input.password)
  }
  return opts.service ? `{ARGON2ID}${hash}` : hash
}

/** Rejects unsupported costs and noncanonical PHC input before allocating native KDF memory. */
export const verifyPasswordArgon2id = async (password: string, encodedHash: string): Promise<boolean> => {
  if (!validPassword(password)) return false
  const parsed = parsePasswordHashArgon2id(encodedHash)
  if (!parsed) return false
  const { params, expected } = parsed
  const actual = await deriveArgon2idDigest(password, params, expected.byteLength)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

// ---- RFC 4648 Base32 & RFC 6238 TOTP -------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return out
}

export const decodeBase32 = (input: string): Buffer => {
  if (typeof input !== 'string') fail('VALIDATION', 'base32 secret must be a string')
  const clean = input.replace(/[\s=-]+/g, '').toUpperCase()
  if (clean.length === 0) fail('VALIDATION', 'base32 secret must not be empty')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]!)
    if (idx === -1) fail('VALIDATION', 'invalid base32 character in TOTP secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Generates a 160-bit (20-byte) RFC 4648 Base32 TOTP secret. */
export const generateTotpSecret = (): string => encodeBase32(randomBytes(20))

/** Computes a 6-digit RFC 6238 TOTP code (HMAC-SHA1, 30-second time step). */
export const computeTotpCode = (secretBase32: string, timestampMs: number = Date.now()): string => {
  const key = decodeBase32(secretBase32)
  const step = BigInt(Math.floor(timestampMs / 30_000))
  const counter = Buffer.alloc(8)
  counter.writeBigInt64BE(step, 0)
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000
  return String(code).padStart(6, '0')
}

/** Returns the matched RFC 6238 counter for an atomic, persisted replay check. */
export const verifyTotpStep = (
  secretBase32: string,
  code: string,
  timestampMs: number = Date.now(),
  windowSteps = 1,
): number | null => {
  if (typeof code !== 'string' || !Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isFinite(windowSteps)) return null
  const normalized = code.trim()
  if (!/^\d{6}$/.test(normalized)) return null
  const codeBuf = Buffer.from(normalized, 'utf8')
  const steps = Math.max(0, Math.min(10, Math.floor(windowSteps)))
  let matchedStep: number | null = null
  for (let delta = -steps; delta <= steps; delta++) {
    const candidateTime = timestampMs + delta * 30_000
    if (candidateTime < 0) continue
    let candidate: string
    try {
      candidate = computeTotpCode(secretBase32, candidateTime)
    } catch {
      return null
    }
    const candidateBuf = Buffer.from(candidate, 'utf8')
    if (candidateBuf.byteLength === codeBuf.byteLength && timingSafeEqual(candidateBuf, codeBuf)) {
      matchedStep = Math.floor(candidateTime / 30_000)
    }
  }
  return matchedStep
}

/** Verifies the code without claiming its counter; granting access also requires a persisted replay check. */
export const verifyTotpCode = (
  secretBase32: string,
  code: string,
  timestampMs: number = Date.now(),
  windowSteps = 1,
): boolean => verifyTotpStep(secretBase32, code, timestampMs, windowSteps) !== null

const requireServerSecret = (serverSecret: string): void => {
  if (typeof serverSecret !== 'string' || serverSecret.length === 0) {
    fail('VALIDATION', 'serverSecret is required to seal or unseal TOTP secrets')
  }
}

/** Seals a Base32 TOTP secret using AES-256-GCM derived from `serverSecret`. */
export const sealTotpSecret = (secretBase32: string, serverSecret: string): Uint8Array => {
  requireServerSecret(serverSecret)
  const key = createHash('sha256').update(`totp-seal:${serverSecret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return new Uint8Array(Buffer.concat([iv, tag, encrypted]))
}

/** Unseals a TOTP secret sealed by `sealTotpSecret`. */
export const unsealTotpSecret = (sealed: Uint8Array, serverSecret: string): string => {
  requireServerSecret(serverSecret)
  const buf = Buffer.from(sealed)
  if (buf.byteLength < 29) fail('VALIDATION', 'invalid sealed TOTP secret')
  const key = createHash('sha256').update(`totp-seal:${serverSecret}`).digest()
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return fail('PRECONDITION_FAILED', 'two-factor key recovery is required; sealed TOTP secret could not be unsealed')
  }
}

export const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

// ---- Cookies & CSRF ------------------------------------------------------------------

export const parseCookies = (cookieHeader: string | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return out
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') continue
    let raw = part.slice(eq + 1).trim()
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1)
    }
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

export const formatSessionCookie = (
  token: string,
  opts?: { secure?: boolean; maxAgeSec?: number },
): string => {
  const secure = opts?.secure ?? false
  const name = secure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
  const maxAge = Math.max(0, Math.floor(opts?.maxAgeSec ?? 86_400))
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`]
  if (secure) attrs.push('Secure')
  return `${name}=${encodeURIComponent(token)}; ${attrs.join('; ')}`
}

export const clearSessionCookie = (opts?: { secure?: boolean }): string => {
  const secure = opts?.secure ?? false
  const name = secure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) attrs.push('Secure')
  return `${name}=; ${attrs.join('; ')}`
}

export const deriveCsrfToken = (sessionToken: string, serverSecret: string): string => {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
    fail('VALIDATION', 'sessionToken is required to derive CSRF token')
  }
  if (typeof serverSecret !== 'string' || serverSecret.length === 0) {
    fail('VALIDATION', 'serverSecret is required to derive CSRF token')
  }
  return createHmac('sha256', serverSecret).update(`csrf:${sessionToken}`).digest('hex')
}

export const verifyCsrfToken = (
  sessionToken: string,
  csrfHeader: string | null,
  serverSecret: string,
): boolean => {
  if (
    typeof sessionToken !== 'string' ||
    sessionToken.length === 0 ||
    typeof csrfHeader !== 'string' ||
    csrfHeader.trim().length === 0 ||
    typeof serverSecret !== 'string' ||
    serverSecret.length === 0
  ) {
    return false
  }
  const expected = Buffer.from(deriveCsrfToken(sessionToken, serverSecret), 'utf8')
  const actual = Buffer.from(csrfHeader.trim(), 'utf8')
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}

// ---- Request Authentication ----------------------------------------------------------

export interface AuthenticatedCaller {
  principal: Principal
  principalRecord: PrincipalRecord
  sessionId: string | null
  sessionToken: string | null
  apiTokenId: string | null
  scopes: string[]
  csrfValid: boolean
  mfaVerified: boolean
}

export const principalRecordToPrincipal = (record: PrincipalRecord): Principal => {
  switch (record.kind) {
    case 'root':
      return { kind: 'root', id: record.id, username: record.username }
    case 'reseller':
      return { kind: 'reseller', id: record.id, username: record.username }
    case 'user':
      if (!record.accountId) return fail('VALIDATION', `user principal ${record.username} is missing accountId`)
      return { kind: 'user', id: record.id, username: record.username, accountId: record.accountId }
  }
}

const isClientIpAllowed = (allowedIps: readonly string[], clientIp: string | null): boolean => {
  if (allowedIps.length === 0) return true
  if (!clientIp) return false
  const parsedIp = parseIp(clientIp)
  if (!parsedIp) return false
  for (const entry of allowedIps) {
    const cidr = parseCidr(entry)
    if (cidr && cidrContains(cidr, parsedIp)) return true
  }
  return false
}

/**
 * Authenticates an incoming HTTP `Request` via either:
 * - Bearer API token (`Authorization: Bearer xp_...`)
 * - Session cookie (`__Host-xpanel_session` or `xpanel_session`)
 */
export const authenticateRequest = async (
  db: Db,
  req: Request,
  opts: { serverSecret: string; clientIp?: string | null; touchSession?: boolean },
): Promise<AuthenticatedCaller | null> => {
  const authHeader = req.headers.get('authorization')
  if (authHeader) {
    const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authHeader.trim())
    if (!bearerMatch) return null
    const rawToken = bearerMatch[1]!
    const tokenHash = sha256Hex(rawToken)
    const apiToken = await findActiveApiTokenByHash(db, tokenHash)
    if (!apiToken) return null
    if (!isClientIpAllowed(apiToken.allowedIps, opts.clientIp ?? null)) {
      return null
    }
    const principalRecord = await getPrincipal(db, apiToken.principalId)
    if (!principalRecord || principalRecord.disabled) return null
    return {
      principal: principalRecordToPrincipal(principalRecord),
      principalRecord,
      sessionId: null,
      sessionToken: null,
      apiTokenId: apiToken.id,
      scopes: apiToken.scopes,
      csrfValid: true,
      mfaVerified: true,
    }
  }

  const cookies = parseCookies(req.headers.get('cookie'))
  const sessionToken = cookies[HOST_SESSION_COOKIE_NAME] ?? cookies[SESSION_COOKIE_NAME]
  if (!sessionToken) return null

  const tokenHash = sha256Hex(sessionToken)
  const session = await findActiveSessionByTokenHash(db, tokenHash)
  if (!session) return null
  const now = Date.now()
  const createdAt = Date.parse(session.createdAt)
  const lastSeenAt = Date.parse(session.lastSeenAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt) ||
      now - createdAt >= SESSION_ABSOLUTE_TIMEOUT_MS || now - lastSeenAt >= SESSION_IDLE_TIMEOUT_MS) return null

  const principalRecord = await getPrincipal(db, session.principalId)
  if (!principalRecord || principalRecord.disabled) return null

  if (opts.touchSession !== false) await touchSession(db, session.id)
  const csrfHeader = req.headers.get(CSRF_HEADER_NAME) ?? req.headers.get('x-xsrf-token')
  const csrfValid = verifyCsrfToken(sessionToken, csrfHeader, opts.serverSecret)
  const mfaSatisfied = !principalRecord.totpEnabled || (principalRecord.totpSecretEnc !== null && session.mfaVerified)

  return {
    principal: principalRecordToPrincipal(principalRecord),
    principalRecord,
    sessionId: session.id,
    sessionToken,
    apiTokenId: null,
    scopes: mfaSatisfied ? ['*'] : ['mfa:verify'],
    csrfValid,
    mfaVerified: mfaSatisfied,
  }
}
