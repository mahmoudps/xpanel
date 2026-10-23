import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertArgon2Hash,
  assertId,
  assertIsoDate,
  assertSha256Hex,
  fail,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import { createDb, type Db } from './client.ts'
import { currentSchemaVersion } from './migrate.ts'
import { DERIVED_INDEX_TABLES } from './schema.ts'
import { withSqliteErrors } from './sqlite-errors.ts'
import { revokeAllApiTokensForPrincipal } from './repos/api-tokens.ts'
import { appendAudit } from './repos/audit.ts'
import { revokeAllSessionsForPrincipal } from './repos/sessions.ts'
import { nowIso } from './repos/util.ts'

/**
 * Operational SQLite tables that form the panel's identity & credential authority.
 * Unlike `DERIVED_INDEX_TABLES` (`idx_*` + `search_fts`), these tables cannot be
 * reconstructed by `reindexFromState` and require dedicated snapshot backup + watermarked recovery.
 */
export const IDENTITY_AUTHORITY_TABLES = [
  'principals',
  'sessions',
  'totp_enrollments',
  'api_tokens',
  'lockouts',
  'login_failure_counters',
  'login_attempts',
  'audit_log',
] as const

export { DERIVED_INDEX_TABLES }

const BACKUP_SNAPSHOT_FILENAME = 'identity-snapshot.db'
const BACKUP_MANIFEST_FILENAME = 'identity-manifest.json'
const BACKUP_WATERMARK_FILENAME = 'revocation-watermark.json'
const MIN_SERVER_SECRET_BYTES = 32

const sha256Buffer = (buf: Uint8Array | string): string =>
  createHash('sha256').update(buf).digest('hex')

const requireValidServerSecret = (serverSecret: string, label = 'serverSecret'): string => {
  if (typeof serverSecret !== 'string' || serverSecret.length === 0 || serverSecret.includes('\0')) {
    return fail('VALIDATION', `${label} must be a non-empty string without NUL bytes`)
  }
  return serverSecret
}

const requireStrongServerSecret = (serverSecret: string, label = 'newServerSecret'): string => {
  requireValidServerSecret(serverSecret, label)
  if (Buffer.byteLength(serverSecret, 'utf8') < MIN_SERVER_SECRET_BYTES) {
    return fail('PRECONDITION_FAILED', `${label} must be at least ${MIN_SERVER_SECRET_BYTES} UTF-8 bytes`)
  }
  return serverSecret
}

const requireBackupDir = (backupDir: string): string => {
  if (typeof backupDir !== 'string' || backupDir.trim().length === 0 || backupDir.includes('\0')) {
    return fail('VALIDATION', 'backupDir must be a non-empty directory path')
  }
  return backupDir
}

/**
 * Returns a non-invertible HMAC-SHA256 fingerprint of the MFA sealing secret
 * so backup manifests can detect seal-key mismatches without storing the secret.
 */
export const computeSealKeyFingerprint = (serverSecret: string): string => {
  requireValidServerSecret(serverSecret)
  return createHmac('sha256', serverSecret).update('xpanel-totp-seal-key-v1').digest('hex')
}

/** Seals a Base32 TOTP secret using AES-256-GCM derived from `serverSecret`. */
export const sealTotpSecretWithKey = (secretBase32: string, serverSecret: string): Uint8Array => {
  requireValidServerSecret(serverSecret)
  if (typeof secretBase32 !== 'string' || secretBase32.trim().length === 0) {
    fail('VALIDATION', 'TOTP secret must be a non-empty Base32 string')
  }
  const key = createHash('sha256').update(`totp-seal:${serverSecret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return new Uint8Array(Buffer.concat([iv, tag, encrypted]))
}

/** Unseals a TOTP secret sealed by `sealTotpSecret` / `sealTotpSecretWithKey`. */
export const unsealTotpSecretWithKey = (sealed: Uint8Array, serverSecret: string): string => {
  requireValidServerSecret(serverSecret)
  const buf = Buffer.from(sealed)
  if (buf.byteLength < 29 || buf.byteLength > 1024) {
    return fail('VALIDATION', 'invalid sealed TOTP secret')
  }
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

export const canUnsealTotpSecret = (sealed: Uint8Array, serverSecret: string): boolean => {
  try {
    const plain = unsealTotpSecretWithKey(sealed, serverSecret)
    return plain.length > 0
  } catch {
    return false
  }
}

export interface PrincipalAuthorityWatermark {
  id: Id
  username: string
  passwordHashSha256: string
  passwordChangedAt: string
  totpEnabled: boolean
  totpSecretSha256: string | null
  totpEnabledAt: string | null
  totpLastStep: number | null
  remainingRecoveryHashes: string[]
  consumedRecoveryHashes: string[]
  disabled: boolean
  updatedAt: string
  revokedAllBefore: string | null
}

export interface RevocationWatermark {
  version: 1
  epoch: number
  capturedAt: string
  revokedSessionIds: string[]
  revokedSessionTokenHashes: string[]
  revokedApiTokenIds: string[]
  revokedApiTokenHashes: string[]
  principals: Record<string, PrincipalAuthorityWatermark>
  sha256: string
}

interface PrincipalSnapshotRow {
  id: string
  kind: 'root' | 'reseller' | 'user'
  username: string
  password_hash: string
  force_password_change: number
  password_changed_at: string
  totp_secret_enc: Uint8Array | null
  totp_enabled_at: string | null
  totp_recovery_hashes: string
  totp_last_step: number | null
  account_id: string | null
  disabled: number
  last_login_at: string | null
  created_at: string
  updated_at: string
  [k: string]: unknown
}

interface SessionSnapshotRow {
  id: string
  principal_id: string
  token_hash: string
  ip: string | null
  user_agent: string | null
  mfa_verified: number
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  [k: string]: unknown
}

interface ApiTokenSnapshotRow {
  id: string
  principal_id: string
  name: string
  token_hash: string
  scopes: string
  allowed_ips: string
  expires_at: string
  last_used_at: string | null
  last_used_ip: string | null
  created_at: string
  revoked_at: string | null
  [k: string]: unknown
}

interface TotpEnrollmentSnapshotRow {
  principal_id: string
  enrollment_id: string
  session_id: string
  sealed_secret: Uint8Array
  recovery_hashes: string
  created_at: string
  expires_at: string
  [k: string]: unknown
}

interface LockoutSnapshotRow {
  id: string
  username: string | null
  ip: string | null
  failures: number
  reason: string
  locked_until: string
  created_at: string
  [k: string]: unknown
}

interface FailureCounterSnapshotRow {
  subject_kind: 'username' | 'ip'
  subject_value: string
  failures: number
  window_started_at: string
  [k: string]: unknown
}

interface LoginAttemptSnapshotRow {
  id: number
  at: string
  surface: 'panel' | 'api' | 'webmail'
  username: string
  ip: string
  success: number
  reason: string | null
  [k: string]: unknown
}

interface AuditSnapshotRow {
  id: number
  at: string
  actor: string
  principal_id: string | null
  ip: string | null
  action: string
  target: string
  detail: string
  outcome: 'ok' | 'denied' | 'failed'
  [k: string]: unknown
}

const canonicalWatermarkPayload = (wm: Omit<RevocationWatermark, 'sha256'>): string => {
  const sortedPrincipals: Record<string, PrincipalAuthorityWatermark> = {}
  for (const key of Object.keys(wm.principals).sort()) {
    const p = wm.principals[key]!
    sortedPrincipals[key] = {
      id: p.id,
      username: p.username,
      passwordHashSha256: p.passwordHashSha256,
      passwordChangedAt: p.passwordChangedAt,
      totpEnabled: p.totpEnabled,
      totpSecretSha256: p.totpSecretSha256,
      totpEnabledAt: p.totpEnabledAt,
      totpLastStep: p.totpLastStep,
      remainingRecoveryHashes: [...p.remainingRecoveryHashes].sort(),
      consumedRecoveryHashes: [...p.consumedRecoveryHashes].sort(),
      disabled: p.disabled,
      updatedAt: p.updatedAt,
      revokedAllBefore: p.revokedAllBefore,
    }
  }
  return JSON.stringify({
    version: wm.version,
    epoch: wm.epoch,
    capturedAt: wm.capturedAt,
    revokedSessionIds: [...wm.revokedSessionIds].sort(),
    revokedSessionTokenHashes: [...wm.revokedSessionTokenHashes].sort(),
    revokedApiTokenIds: [...wm.revokedApiTokenIds].sort(),
    revokedApiTokenHashes: [...wm.revokedApiTokenHashes].sort(),
    principals: sortedPrincipals,
  })
}

const signWatermark = (wm: Omit<RevocationWatermark, 'sha256'>): RevocationWatermark => {
  const sortedPrincipals: Record<string, PrincipalAuthorityWatermark> = {}
  for (const key of Object.keys(wm.principals).sort()) {
    const p = wm.principals[key]!
    sortedPrincipals[key] = {
      ...p,
      remainingRecoveryHashes: [...new Set(p.remainingRecoveryHashes)].sort(),
      consumedRecoveryHashes: [...new Set(p.consumedRecoveryHashes)].sort(),
    }
  }
  const normalized: Omit<RevocationWatermark, 'sha256'> = {
    version: 1,
    epoch: wm.epoch,
    capturedAt: wm.capturedAt,
    revokedSessionIds: [...new Set(wm.revokedSessionIds)].sort(),
    revokedSessionTokenHashes: [...new Set(wm.revokedSessionTokenHashes.map((h) => h.toLowerCase()))].sort(),
    revokedApiTokenIds: [...new Set(wm.revokedApiTokenIds)].sort(),
    revokedApiTokenHashes: [...new Set(wm.revokedApiTokenHashes.map((h) => h.toLowerCase()))].sort(),
    principals: sortedPrincipals,
  }
  return {
    ...normalized,
    sha256: sha256Buffer(canonicalWatermarkPayload(normalized)),
  }
}

export const verifyRevocationWatermark = (watermark: unknown): RevocationWatermark => {
  if (!watermark || typeof watermark !== 'object') {
    return fail('PRECONDITION_FAILED', 'revocation watermark must be an object')
  }
  const candidate = watermark as RevocationWatermark
  if (candidate.version !== 1 || !Number.isSafeInteger(candidate.epoch) || candidate.epoch < 1) {
    return fail('PRECONDITION_FAILED', 'revocation watermark version or epoch is invalid')
  }
  assertIsoDate(candidate.capturedAt, 'watermark.capturedAt')
  if (typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.sha256)) {
    return fail('PRECONDITION_FAILED', 'revocation watermark sha256 is invalid')
  }
  const expected = signWatermark(candidate)
  if (expected.sha256 !== candidate.sha256) {
    return fail('PRECONDITION_FAILED', 'revocation watermark checksum mismatch')
  }
  return expected
}

const laterIso = (a: string | null, b: string | null): string | null => {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/**
 * Monotonically merges revocation watermarks so revocations, consumed recovery codes,
 * TOTP replay barriers, and credential epochs only advance and never regress.
 */
export const mergeRevocationWatermarks = (watermarks: readonly RevocationWatermark[]): RevocationWatermark => {
  if (watermarks.length === 0) {
    return signWatermark({
      version: 1,
      epoch: 1,
      capturedAt: nowIso(),
      revokedSessionIds: [],
      revokedSessionTokenHashes: [],
      revokedApiTokenIds: [],
      revokedApiTokenHashes: [],
      principals: {},
    })
  }
  const verified = watermarks.map(verifyRevocationWatermark)
  let maxEpoch = 0
  let latestCapturedAt = verified[0]!.capturedAt
  const revokedSessionIds = new Set<string>()
  const revokedSessionTokenHashes = new Set<string>()
  const revokedApiTokenIds = new Set<string>()
  const revokedApiTokenHashes = new Set<string>()
  const principals: Record<string, PrincipalAuthorityWatermark> = {}

  for (const wm of verified) {
    if (wm.epoch > maxEpoch) maxEpoch = wm.epoch
    latestCapturedAt = laterIso(latestCapturedAt, wm.capturedAt) ?? latestCapturedAt
    for (const id of wm.revokedSessionIds) revokedSessionIds.add(id)
    for (const h of wm.revokedSessionTokenHashes) revokedSessionTokenHashes.add(h.toLowerCase())
    for (const id of wm.revokedApiTokenIds) revokedApiTokenIds.add(id)
    for (const h of wm.revokedApiTokenHashes) revokedApiTokenHashes.add(h.toLowerCase())

    for (const [pid, incoming] of Object.entries(wm.principals)) {
      const existing = principals[pid]
      if (!existing) {
        principals[pid] = {
          ...incoming,
          remainingRecoveryHashes: [...incoming.remainingRecoveryHashes],
          consumedRecoveryHashes: [...incoming.consumedRecoveryHashes],
        }
        continue
      }
      const incomingIsNewer = Date.parse(incoming.updatedAt) >= Date.parse(existing.updatedAt)
      const latest = incomingIsNewer ? incoming : existing
      const older = incomingIsNewer ? existing : incoming
      const sameTotpSecret =
        latest.totpSecretSha256 !== null && latest.totpSecretSha256 === older.totpSecretSha256
      const passwordChanged = existing.passwordHashSha256 !== incoming.passwordHashSha256
      const totpChanged = existing.totpSecretSha256 !== incoming.totpSecretSha256

      const consumed = new Set<string>()
      if (sameTotpSecret) {
        for (const h of existing.consumedRecoveryHashes) consumed.add(h)
        for (const h of incoming.consumedRecoveryHashes) consumed.add(h)
        for (const h of older.remainingRecoveryHashes) {
          if (!latest.remainingRecoveryHashes.includes(h)) consumed.add(h)
        }
      } else {
        for (const h of latest.consumedRecoveryHashes) consumed.add(h)
      }
      const remaining = latest.remainingRecoveryHashes.filter((h) => !consumed.has(h))
      const totpLastStep = sameTotpSecret
        ? existing.totpLastStep === null
          ? incoming.totpLastStep
          : incoming.totpLastStep === null
            ? existing.totpLastStep
            : Math.max(existing.totpLastStep, incoming.totpLastStep)
        : latest.totpLastStep

      let revokedAllBefore = laterIso(existing.revokedAllBefore, incoming.revokedAllBefore)
      if (passwordChanged) {
        revokedAllBefore = laterIso(revokedAllBefore, laterIso(existing.passwordChangedAt, incoming.passwordChangedAt))
      }
      if (totpChanged) {
        revokedAllBefore = laterIso(revokedAllBefore, latest.updatedAt)
      }

      principals[pid] = {
        id: latest.id,
        username: latest.username,
        passwordHashSha256: latest.passwordHashSha256,
        passwordChangedAt: laterIso(existing.passwordChangedAt, incoming.passwordChangedAt) ?? latest.passwordChangedAt,
        totpEnabled: latest.totpEnabled,
        totpSecretSha256: latest.totpSecretSha256,
        totpEnabledAt: latest.totpEnabledAt,
        totpLastStep,
        remainingRecoveryHashes: remaining,
        consumedRecoveryHashes: [...consumed],
        disabled: latest.disabled,
        updatedAt: laterIso(existing.updatedAt, incoming.updatedAt) ?? latest.updatedAt,
        revokedAllBefore,
      }
    }
  }

  return signWatermark({
    version: 1,
    epoch: maxEpoch + 1,
    capturedAt: laterIso(latestCapturedAt, nowIso()) ?? nowIso(),
    revokedSessionIds: [...revokedSessionIds],
    revokedSessionTokenHashes: [...revokedSessionTokenHashes],
    revokedApiTokenIds: [...revokedApiTokenIds],
    revokedApiTokenHashes: [...revokedApiTokenHashes],
    principals,
  })
}

const writeAtomicFile = async (targetPath: string, content: string): Promise<void> => {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, targetPath)
}

/**
 * Captures a cryptographic revocation & credential epoch watermark from `db`,
 * merging monotonically with `opts.previousWatermark` when supplied.
 */
export const captureRevocationWatermark = async (
  db: Db,
  opts: { previousWatermark?: RevocationWatermark; watermarkPath?: string } = {},
): Promise<RevocationWatermark> => {
  const [principalRows, sessionRows, tokenRows] = await Promise.all([
    db.query<PrincipalSnapshotRow>(`SELECT * FROM principals ORDER BY id ASC`),
    db.query<SessionSnapshotRow>(`SELECT * FROM sessions ORDER BY id ASC`),
    db.query<ApiTokenSnapshotRow>(`SELECT * FROM api_tokens ORDER BY id ASC`),
  ])

  const revokedSessionIds: string[] = []
  const revokedSessionTokenHashes: string[] = []
  const maxSessionRevokedByPrincipal = new Map<string, string>()

  for (const s of sessionRows) {
    if (s.revoked_at !== null) {
      revokedSessionIds.push(s.id)
      revokedSessionTokenHashes.push(s.token_hash.toLowerCase())
      const prev = maxSessionRevokedByPrincipal.get(s.principal_id) ?? null
      maxSessionRevokedByPrincipal.set(s.principal_id, laterIso(prev, s.revoked_at)!)
    }
  }

  const revokedApiTokenIds: string[] = []
  const revokedApiTokenHashes: string[] = []
  const maxTokenRevokedByPrincipal = new Map<string, string>()

  for (const t of tokenRows) {
    if (t.revoked_at !== null) {
      revokedApiTokenIds.push(t.id)
      revokedApiTokenHashes.push(t.token_hash.toLowerCase())
      const prev = maxTokenRevokedByPrincipal.get(t.principal_id) ?? null
      maxTokenRevokedByPrincipal.set(t.principal_id, laterIso(prev, t.revoked_at)!)
    }
  }

  const principals: Record<string, PrincipalAuthorityWatermark> = {}
  for (const p of principalRows) {
    assertArgon2Hash(p.password_hash)
    const remaining = (JSON.parse(p.totp_recovery_hashes) as string[]).map((h) => assertSha256Hex(h, 'recoveryHash'))
    const secretSha = p.totp_secret_enc ? sha256Buffer(new Uint8Array(p.totp_secret_enc)) : null
    const hasActiveSessions = sessionRows.some((s) => s.principal_id === p.id && s.revoked_at === null)
    const hasActiveTokens = tokenRows.some((t) => t.principal_id === p.id && t.revoked_at === null)
    const latestRevoked = laterIso(
      maxSessionRevokedByPrincipal.get(p.id) ?? null,
      maxTokenRevokedByPrincipal.get(p.id) ?? null,
    )
    // A live session shares the principal's password timestamp when both are created in
    // the same millisecond. The cutoff would revoke it. Password changes revoke every
    // session first, so the cutoff still applies once none remain.
    const revokedAllBefore = hasActiveSessions || hasActiveTokens
      ? null
      : laterIso(p.password_changed_at, latestRevoked)

    principals[p.id] = {
      id: p.id,
      username: p.username,
      passwordHashSha256: sha256Buffer(p.password_hash),
      passwordChangedAt: p.password_changed_at,
      totpEnabled: p.totp_enabled_at !== null,
      totpSecretSha256: secretSha,
      totpEnabledAt: p.totp_enabled_at,
      totpLastStep: p.totp_last_step,
      remainingRecoveryHashes: remaining,
      consumedRecoveryHashes: [],
      disabled: Boolean(p.disabled),
      updatedAt: p.updated_at,
      revokedAllBefore,
    }
  }

  const current = signWatermark({
    version: 1,
    epoch: 1,
    capturedAt: nowIso(),
    revokedSessionIds,
    revokedSessionTokenHashes,
    revokedApiTokenIds,
    revokedApiTokenHashes,
    principals,
  })

  const merged = opts.previousWatermark
    ? mergeRevocationWatermarks([opts.previousWatermark, current])
    : current

  if (opts.watermarkPath) {
    await mkdir(join(opts.watermarkPath, '..'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(opts.watermarkPath, JSON.stringify(merged, null, 2))
  }
  return merged
}

export const readRevocationWatermark = async (watermarkPath: string): Promise<RevocationWatermark> => {
  if (typeof watermarkPath !== 'string' || watermarkPath.trim().length === 0 || watermarkPath.includes('\0')) {
    return fail('VALIDATION', 'watermarkPath must be a non-empty file path')
  }
  const raw = await readFile(watermarkPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('PRECONDITION_FAILED', 'revocation watermark file is not valid JSON')
  }
  return verifyRevocationWatermark(parsed)
}

export interface IdentityAuthorityBackupCounts {
  principals: number
  activeSessions: number
  revokedSessions: number
  activeApiTokens: number
  revokedApiTokens: number
  pendingEnrollments: number
  lockouts: number
  loginFailureCounters: number
  loginAttempts: number
  auditEntries: number
}

export interface IdentityAuthorityBackupManifest {
  version: 1
  schemaVersion: number
  createdAt: string
  snapshotFilename: string
  snapshotSha256: string
   snapshotBytes: number
  sealKeyFingerprint: string | null
  counts: IdentityAuthorityBackupCounts
  watermark: RevocationWatermark
  manifestSha256: string
}

const canonicalManifestPayload = (m: Omit<IdentityAuthorityBackupManifest, 'manifestSha256'>): string =>
  JSON.stringify({
    version: m.version,
    schemaVersion: m.schemaVersion,
    createdAt: m.createdAt,
    snapshotFilename: m.snapshotFilename,
    snapshotSha256: m.snapshotSha256,
    snapshotBytes: m.snapshotBytes,
    sealKeyFingerprint: m.sealKeyFingerprint,
    counts: m.counts,
    watermarkSha256: m.watermark.sha256,
  })

const assertPrincipalsUnsealable = async (db: Db, serverSecret: string): Promise<number> => {
  const principals = await db.query<{ id: string; username: string; totp_secret_enc: Uint8Array | null }>(
    `SELECT id, username, totp_secret_enc FROM principals WHERE totp_secret_enc IS NOT NULL`,
  )
  const enrollments = await db.query<{ principal_id: string; sealed_secret: Uint8Array }>(
    `SELECT principal_id, sealed_secret FROM totp_enrollments`,
  )
  for (const p of principals) {
    if (p.totp_secret_enc && !canUnsealTotpSecret(new Uint8Array(p.totp_secret_enc), serverSecret)) {
      fail('PRECONDITION_FAILED', `principal "${p.username}" has a sealed MFA secret that cannot be unsealed with the supplied serverSecret`)
    }
  }
  for (const e of enrollments) {
    if (!canUnsealTotpSecret(new Uint8Array(e.sealed_secret), serverSecret)) {
      fail('PRECONDITION_FAILED', `pending TOTP enrollment for principal "${e.principal_id}" cannot be unsealed with the supplied serverSecret`)
    }
  }
  return principals.length
}

/**
 * Creates a consistent SQLite snapshot (`VACUUM INTO`) of the identity database along with a
 * signed SHA-256 manifest, seal-key commitment fingerprint, and revocation watermark.
 */
export const createIdentityAuthorityBackup = (
  db: Db,
  opts: {
    backupDir: string
    serverSecret?: string
    previousWatermark?: RevocationWatermark
  },
): Promise<IdentityAuthorityBackupManifest> =>
  withSqliteErrors(async () => {
    const backupDir = requireBackupDir(opts.backupDir)
    if (opts.serverSecret !== undefined) {
      requireValidServerSecret(opts.serverSecret)
      await assertPrincipalsUnsealable(db, opts.serverSecret)
    }
    if (opts.previousWatermark) {
      verifyRevocationWatermark(opts.previousWatermark)
    }

    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    const snapshotPath = join(backupDir, BACKUP_SNAPSHOT_FILENAME)
    const tempSnapshotPath = join(backupDir, `${BACKUP_SNAPSHOT_FILENAME}.${randomUUID()}.tmp`)
    await rm(tempSnapshotPath, { force: true })

    try {
      const escapedTempPath = tempSnapshotPath.replace(/'/g, "''")
      await db.exec(`VACUUM INTO '${escapedTempPath}'`)
      await rm(snapshotPath, { force: true })
      await rename(tempSnapshotPath, snapshotPath)
    } finally {
      await rm(tempSnapshotPath, { force: true }).catch(() => {})
    }

    const snapshotBytesBuf = await readFile(snapshotPath)
    const snapshotSha256 = sha256Buffer(snapshotBytesBuf)
    const snapshotStat = await stat(snapshotPath)

    const snapshotHandle = createDb(snapshotPath, { wal: false })
    try {
      const schemaVersion = await currentSchemaVersion(snapshotHandle.db)
      if (schemaVersion < 1) {
        return fail('PRECONDITION_FAILED', 'cannot back up an unmigrated identity database')
      }
      const watermark = await captureRevocationWatermark(snapshotHandle.db, {
        ...(opts.previousWatermark ? { previousWatermark: opts.previousWatermark } : {}),
        watermarkPath: join(backupDir, BACKUP_WATERMARK_FILENAME),
      })

      const [
        principals,
        activeSessions,
        revokedSessions,
        activeApiTokens,
        revokedApiTokens,
        pendingEnrollments,
        lockouts,
        loginFailureCounters,
        loginAttempts,
        auditEntries,
      ] = await Promise.all([
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM principals`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM sessions WHERE revoked_at IS NULL`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM sessions WHERE revoked_at IS NOT NULL`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM api_tokens WHERE revoked_at IS NULL`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM api_tokens WHERE revoked_at IS NOT NULL`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM totp_enrollments`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM lockouts`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM login_failure_counters`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM login_attempts`),
        snapshotHandle.db.query<{ c: number }>(`SELECT count(*) AS c FROM audit_log`),
      ])

      const counts: IdentityAuthorityBackupCounts = {
        principals: Number(principals[0]?.c ?? 0),
        activeSessions: Number(activeSessions[0]?.c ?? 0),
        revokedSessions: Number(revokedSessions[0]?.c ?? 0),
        activeApiTokens: Number(activeApiTokens[0]?.c ?? 0),
        revokedApiTokens: Number(revokedApiTokens[0]?.c ?? 0),
        pendingEnrollments: Number(pendingEnrollments[0]?.c ?? 0),
        lockouts: Number(lockouts[0]?.c ?? 0),
        loginFailureCounters: Number(loginFailureCounters[0]?.c ?? 0),
        loginAttempts: Number(loginAttempts[0]?.c ?? 0),
        auditEntries: Number(auditEntries[0]?.c ?? 0),
      }

      const unsignedManifest: Omit<IdentityAuthorityBackupManifest, 'manifestSha256'> = {
        version: 1,
        schemaVersion,
        createdAt: nowIso(),
        snapshotFilename: BACKUP_SNAPSHOT_FILENAME,
        snapshotSha256,
        snapshotBytes: snapshotStat.size,
        sealKeyFingerprint: opts.serverSecret ? computeSealKeyFingerprint(opts.serverSecret) : null,
        counts,
        watermark,
      }
      const manifest: IdentityAuthorityBackupManifest = {
        ...unsignedManifest,
        manifestSha256: sha256Buffer(canonicalManifestPayload(unsignedManifest)),
      }

      await writeAtomicFile(join(backupDir, BACKUP_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2))
      return manifest
    } finally {
      await snapshotHandle.close()
    }
  })

export type SealKeyVerificationStatus = 'verified' | 'mismatch' | 'not_checked'

export interface IdentityAuthorityVerificationResult {
  ok: true
  manifest: IdentityAuthorityBackupManifest
  snapshotPath: string
  sealKeyStatus: SealKeyVerificationStatus
  unsealablePrincipalIds: Id[]
}

/**
 * Verifies the cryptographic integrity, SQLite `PRAGMA integrity_check`, schema version,
 * Argon2id credential invariants, and optional MFA sealing key compatibility of a backup.
 */
export const verifyIdentityAuthorityBackup = async (opts: {
  backupDir: string
  serverSecret?: string
  requireMatchingSealKey?: boolean
}): Promise<IdentityAuthorityVerificationResult> => {
  const backupDir = requireBackupDir(opts.backupDir)
  if (opts.serverSecret !== undefined) {
    requireValidServerSecret(opts.serverSecret)
  }

  const manifestPath = join(backupDir, BACKUP_MANIFEST_FILENAME)
  let rawManifest: string
  try {
    rawManifest = await readFile(manifestPath, 'utf8')
  } catch {
    return fail('PRECONDITION_FAILED', 'identity backup manifest is missing or unreadable')
  }

  let manifest: IdentityAuthorityBackupManifest
  try {
    manifest = JSON.parse(rawManifest) as IdentityAuthorityBackupManifest
  } catch {
    return fail('PRECONDITION_FAILED', 'identity backup manifest is not valid JSON')
  }

  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.version !== 1 ||
    manifest.snapshotFilename !== BACKUP_SNAPSHOT_FILENAME ||
    typeof manifest.snapshotSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.snapshotSha256) ||
    typeof manifest.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.manifestSha256)
  ) {
    return fail('PRECONDITION_FAILED', 'identity backup manifest structure is invalid')
  }

  verifyRevocationWatermark(manifest.watermark)
  const expectedManifestSha = sha256Buffer(canonicalManifestPayload(manifest))
  if (expectedManifestSha !== manifest.manifestSha256) {
    return fail('PRECONDITION_FAILED', 'identity backup manifest checksum mismatch')
  }

  const snapshotPath = join(backupDir, BACKUP_SNAPSHOT_FILENAME)
  let snapshotBytes: Buffer
  try {
    snapshotBytes = await readFile(snapshotPath)
  } catch {
    return fail('PRECONDITION_FAILED', 'identity backup SQLite snapshot is missing or unreadable')
  }

  const actualSnapshotSha = sha256Buffer(snapshotBytes)
  if (actualSnapshotSha !== manifest.snapshotSha256 || snapshotBytes.byteLength !== manifest.snapshotBytes) {
    return fail('PRECONDITION_FAILED', 'identity backup SQLite snapshot checksum mismatch')
  }

  const handle = createDb(snapshotPath, { wal: false })
  try {
    const integrity = await handle.db.query<{ integrity_check: string }>(`PRAGMA integrity_check`)
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      return fail('PRECONDITION_FAILED', 'identity backup SQLite integrity_check failed')
    }

    const schemaVersion = await currentSchemaVersion(handle.db)
    if (schemaVersion !== manifest.schemaVersion || schemaVersion < 1) {
      return fail('PRECONDITION_FAILED', 'identity backup schema version mismatch')
    }

    const principals = await handle.db.query<PrincipalSnapshotRow>(`SELECT * FROM principals`)
    const sessions = await handle.db.query<SessionSnapshotRow>(`SELECT * FROM sessions`)
    const apiTokens = await handle.db.query<ApiTokenSnapshotRow>(`SELECT * FROM api_tokens`)
    const enrollments = await handle.db.query<TotpEnrollmentSnapshotRow>(`SELECT * FROM totp_enrollments`)
    const lockouts = await handle.db.query<LockoutSnapshotRow>(`SELECT * FROM lockouts`)
    const counters = await handle.db.query<FailureCounterSnapshotRow>(`SELECT * FROM login_failure_counters`)
    const attempts = await handle.db.query<LoginAttemptSnapshotRow>(`SELECT * FROM login_attempts`)
    const audits = await handle.db.query<AuditSnapshotRow>(`SELECT * FROM audit_log`)

    const activeSessions = sessions.filter((s) => s.revoked_at === null).length
    const revokedSessions = sessions.length - activeSessions
    const activeApiTokens = apiTokens.filter((t) => t.revoked_at === null).length
    const revokedApiTokens = apiTokens.length - activeApiTokens

    if (
      principals.length !== manifest.counts.principals ||
      activeSessions !== manifest.counts.activeSessions ||
      revokedSessions !== manifest.counts.revokedSessions ||
      activeApiTokens !== manifest.counts.activeApiTokens ||
      revokedApiTokens !== manifest.counts.revokedApiTokens ||
      enrollments.length !== manifest.counts.pendingEnrollments ||
      lockouts.length !== manifest.counts.lockouts ||
      counters.length !== manifest.counts.loginFailureCounters ||
      attempts.length !== manifest.counts.loginAttempts ||
      audits.length !== manifest.counts.auditEntries
    ) {
      return fail('PRECONDITION_FAILED', 'identity backup row counts do not match signed manifest')
    }

    const unsealablePrincipalIds: Id[] = []
    let sealKeyStatus: SealKeyVerificationStatus = 'not_checked'

    for (const p of principals) {
      assertArgon2Hash(p.password_hash)
      const recoveryHashes = JSON.parse(p.totp_recovery_hashes) as unknown[]
      for (const h of recoveryHashes) assertSha256Hex(h, 'recoveryHash')
      if (opts.serverSecret !== undefined && p.totp_secret_enc) {
        if (!canUnsealTotpSecret(new Uint8Array(p.totp_secret_enc), opts.serverSecret)) {
          unsealablePrincipalIds.push(p.id)
        }
      }
    }

    if (opts.serverSecret !== undefined) {
      const fingerprintMatch =
        manifest.sealKeyFingerprint === null ||
        manifest.sealKeyFingerprint === computeSealKeyFingerprint(opts.serverSecret)
      sealKeyStatus = fingerprintMatch && unsealablePrincipalIds.length === 0 ? 'verified' : 'mismatch'
      if (opts.requireMatchingSealKey !== false && sealKeyStatus === 'mismatch') {
        return fail(
          'PRECONDITION_FAILED',
          'MFA sealing secret does not match the identity backup; supply the matching secret or run explicit MFA seal-key recovery',
        )
      }
    }

    return {
      ok: true,
      manifest,
      snapshotPath,
      sealKeyStatus,
      unsealablePrincipalIds,
    }
  } finally {
    await handle.close()
  }
}

export interface IdentityAuthorityRestoreResult {
  restoredPrincipals: number
  restoredActiveSessions: number
  restoredRevokedSessions: number
  restoredActiveApiTokens: number
  restoredRevokedApiTokens: number
  mfaResetPrincipalIds: Id[]
  effectiveWatermark: RevocationWatermark
}

/**
 * Restores the identity authority tables from a verified backup into `targetDb` without
 * touching `idx_*` derived hosting index tables or `config_generations`, while enforcing
 * monotonic revocation watermarks so revoked sessions, API tokens, consumed recovery codes,
 * or consumed TOTP steps can never resurrect.
 */
export const restoreIdentityAuthorityBackup = (
  targetDb: Db,
  opts: {
    backupDir: string
    serverSecret?: string
    watermark?: RevocationWatermark
    onSealKeyMismatch?: 'fail' | 'reset-mfa'
    actor?: string
  },
): Promise<IdentityAuthorityRestoreResult> =>
  withSqliteErrors(async () => {
    const mode = opts.onSealKeyMismatch ?? 'fail'
    if (mode !== 'fail' && mode !== 'reset-mfa') {
      return fail('VALIDATION', 'onSealKeyMismatch must be "fail" or "reset-mfa"')
    }
    const verification = await verifyIdentityAuthorityBackup({
      backupDir: opts.backupDir,
      ...(opts.serverSecret !== undefined ? { serverSecret: opts.serverSecret } : {}),
      requireMatchingSealKey: mode === 'fail',
    })
    if (opts.watermark) {
      verifyRevocationWatermark(opts.watermark)
    }

    const snapshotHandle = createDb(verification.snapshotPath, { wal: false })
    let principals: PrincipalSnapshotRow[]
    let sessions: SessionSnapshotRow[]
    let enrollments: TotpEnrollmentSnapshotRow[]
    let apiTokens: ApiTokenSnapshotRow[]
    let lockouts: LockoutSnapshotRow[]
    let counters: FailureCounterSnapshotRow[]
    let attempts: LoginAttemptSnapshotRow[]
    let audits: AuditSnapshotRow[]

    try {
      ;[principals, sessions, enrollments, apiTokens, lockouts, counters, attempts, audits] = await Promise.all([
        snapshotHandle.db.query<PrincipalSnapshotRow>(`SELECT * FROM principals ORDER BY id ASC`),
        snapshotHandle.db.query<SessionSnapshotRow>(`SELECT * FROM sessions ORDER BY id ASC`),
        snapshotHandle.db.query<TotpEnrollmentSnapshotRow>(`SELECT * FROM totp_enrollments ORDER BY principal_id ASC`),
        snapshotHandle.db.query<ApiTokenSnapshotRow>(`SELECT * FROM api_tokens ORDER BY id ASC`),
        snapshotHandle.db.query<LockoutSnapshotRow>(`SELECT * FROM lockouts ORDER BY id ASC`),
        snapshotHandle.db.query<FailureCounterSnapshotRow>(
          `SELECT * FROM login_failure_counters ORDER BY subject_kind ASC, subject_value ASC`,
        ),
        snapshotHandle.db.query<LoginAttemptSnapshotRow>(`SELECT * FROM login_attempts ORDER BY id ASC`),
        snapshotHandle.db.query<AuditSnapshotRow>(`SELECT * FROM audit_log ORDER BY id ASC`),
      ])
    } finally {
      await snapshotHandle.close()
    }

    const targetWatermark = await captureRevocationWatermark(targetDb)
    const effectiveWatermark = mergeRevocationWatermarks([
      verification.manifest.watermark,
      targetWatermark,
      ...(opts.watermark ? [opts.watermark] : []),
    ])

    const revokedSessionIdSet = new Set(effectiveWatermark.revokedSessionIds)
    const revokedSessionHashSet = new Set(effectiveWatermark.revokedSessionTokenHashes)
    const revokedTokenIdSet = new Set(effectiveWatermark.revokedApiTokenIds)
    const revokedTokenHashSet = new Set(effectiveWatermark.revokedApiTokenHashes)
    const unsealableSet = new Set(verification.unsealablePrincipalIds)
    const sealMismatchGlobal = verification.sealKeyStatus === 'mismatch'

    return targetDb.transaction(async (tx) => {
      const restoredAt = nowIso()

      await tx.exec(`
        DELETE FROM totp_enrollments;
        DELETE FROM sessions;
        DELETE FROM api_tokens;
        DELETE FROM lockouts;
        DELETE FROM login_failure_counters;
        DELETE FROM login_attempts;
        DELETE FROM principals;
      `)

      const mfaResetPrincipalIds: Id[] = []
      const forceRevokeAllPrincipals = new Set<string>()

      for (const p of principals) {
        const wm = effectiveWatermark.principals[p.id]
        const backupSecretSha = p.totp_secret_enc ? sha256Buffer(new Uint8Array(p.totp_secret_enc)) : null
        const sameSecretAsWatermark = wm !== undefined && backupSecretSha !== null && wm.totpSecretSha256 === backupSecretSha
        const credentialChangedAfterBackup =
          wm !== undefined &&
          (wm.passwordHashSha256 !== sha256Buffer(p.password_hash) ||
            Date.parse(wm.passwordChangedAt) > Date.parse(p.password_changed_at) ||
            wm.totpSecretSha256 !== backupSecretSha)

        const needsMfaReset =
          mode === 'reset-mfa' &&
          p.totp_secret_enc !== null &&
          (unsealableSet.has(p.id) || sealMismatchGlobal)

        if (needsMfaReset || credentialChangedAfterBackup) {
          forceRevokeAllPrincipals.add(p.id)
        }
        if (needsMfaReset) {
          mfaResetPrincipalIds.push(p.id)
        }

        const backupRecoveryHashes = JSON.parse(p.totp_recovery_hashes) as string[]
        const consumedSet = new Set(sameSecretAsWatermark ? wm.consumedRecoveryHashes : [])
        const filteredRecoveryHashes = needsMfaReset
          ? []
          : backupRecoveryHashes.filter((h) => !consumedSet.has(h))

        const effectiveTotpLastStep = needsMfaReset
          ? null
          : sameSecretAsWatermark && wm.totpLastStep !== null
            ? p.totp_last_step === null
              ? wm.totpLastStep
              : Math.max(p.totp_last_step, wm.totpLastStep)
            : p.totp_last_step

        const effectivePasswordChangedAt = wm
          ? laterIso(p.password_changed_at, wm.passwordChangedAt) ?? p.password_changed_at
          : p.password_changed_at
        const effectiveUpdatedAt = needsMfaReset
          ? restoredAt
          : wm
            ? laterIso(p.updated_at, wm.updatedAt) ?? p.updated_at
            : p.updated_at

        await tx.query(
          `INSERT INTO principals (
            id, kind, username, password_hash, force_password_change,
            password_changed_at, totp_secret_enc, totp_enabled_at, totp_recovery_hashes,
            totp_last_step, account_id, disabled, last_login_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            p.id,
            p.kind,
            p.username,
            p.password_hash,
            p.force_password_change,
            effectivePasswordChangedAt,
            needsMfaReset ? null : p.totp_secret_enc,
            needsMfaReset ? null : p.totp_enabled_at,
            JSON.stringify(filteredRecoveryHashes),
            effectiveTotpLastStep,
            p.account_id,
            p.disabled,
            p.last_login_at,
            p.created_at,
            effectiveUpdatedAt,
          ],
        )
      }

      let restoredActiveSessions = 0
      let restoredRevokedSessions = 0
      const activeRestoredSessionIds = new Set<string>()

      for (const s of sessions) {
        const wm = effectiveWatermark.principals[s.principal_id]
        const revokedByWatermarkCutoff =
          wm?.revokedAllBefore !== null &&
          wm?.revokedAllBefore !== undefined &&
          Date.parse(s.created_at) <= Date.parse(wm.revokedAllBefore)
        const shouldRevoke =
          s.revoked_at !== null ||
          revokedSessionIdSet.has(s.id) ||
          revokedSessionHashSet.has(s.token_hash.toLowerCase()) ||
          forceRevokeAllPrincipals.has(s.principal_id) ||
          revokedByWatermarkCutoff

        const revokedAt = shouldRevoke ? (s.revoked_at ?? restoredAt) : null
        if (revokedAt === null) {
          restoredActiveSessions++
          activeRestoredSessionIds.add(s.id)
        } else {
          restoredRevokedSessions++
        }

        await tx.query(
          `INSERT INTO sessions (
            id, principal_id, token_hash, ip, user_agent, mfa_verified,
            created_at, last_seen_at, expires_at, revoked_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            s.id,
            s.principal_id,
            s.token_hash.toLowerCase(),
            s.ip,
            s.user_agent,
            s.mfa_verified,
            s.created_at,
            s.last_seen_at,
            s.expires_at,
            revokedAt,
          ],
        )
      }

      let restoredActiveApiTokens = 0
      let restoredRevokedApiTokens = 0

      for (const t of apiTokens) {
        const wm = effectiveWatermark.principals[t.principal_id]
        const revokedByWatermarkCutoff =
          wm?.revokedAllBefore !== null &&
          wm?.revokedAllBefore !== undefined &&
          Date.parse(t.created_at) <= Date.parse(wm.revokedAllBefore)
        const shouldRevoke =
          t.revoked_at !== null ||
          revokedTokenIdSet.has(t.id) ||
          revokedTokenHashSet.has(t.token_hash.toLowerCase()) ||
          forceRevokeAllPrincipals.has(t.principal_id) ||
          revokedByWatermarkCutoff

        const revokedAt = shouldRevoke ? (t.revoked_at ?? restoredAt) : null
        if (revokedAt === null) {
          restoredActiveApiTokens++
        } else {
          restoredRevokedApiTokens++
        }

        await tx.query(
          `INSERT INTO api_tokens (
            id, principal_id, name, token_hash, scopes, allowed_ips,
            expires_at, last_used_at, last_used_ip, created_at, revoked_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            t.id,
            t.principal_id,
            t.name,
            t.token_hash.toLowerCase(),
            t.scopes,
            t.allowed_ips,
            t.expires_at,
            t.last_used_at,
            t.last_used_ip,
            t.created_at,
            revokedAt,
          ],
        )
      }

      for (const e of enrollments) {
        if (forceRevokeAllPrincipals.has(e.principal_id)) continue
        if (!activeRestoredSessionIds.has(e.session_id)) continue
        if (Date.parse(e.expires_at) <= Date.parse(restoredAt)) continue
        if (opts.serverSecret !== undefined && !canUnsealTotpSecret(new Uint8Array(e.sealed_secret), opts.serverSecret)) {
          continue
        }
        await tx.query(
          `INSERT INTO totp_enrollments (
            principal_id, enrollment_id, session_id, sealed_secret, recovery_hashes, created_at, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            e.principal_id,
            e.enrollment_id,
            e.session_id,
            e.sealed_secret,
            e.recovery_hashes,
            e.created_at,
            e.expires_at,
          ],
        )
      }

      for (const l of lockouts) {
        await tx.query(
          `INSERT INTO lockouts (id, username, ip, failures, reason, locked_until, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [l.id, l.username, l.ip, l.failures, l.reason, l.locked_until, l.created_at],
        )
      }

      for (const c of counters) {
        await tx.query(
          `INSERT INTO login_failure_counters (subject_kind, subject_value, failures, window_started_at)
           VALUES ($1, $2, $3, $4)`,
          [c.subject_kind, c.subject_value, c.failures, c.window_started_at],
        )
      }

      for (const a of attempts) {
        await tx.query(
          `INSERT INTO login_attempts (id, at, surface, username, ip, success, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [a.id, a.at, a.surface, a.username, a.ip, a.success, a.reason],
        )
      }

      const existingAuditCountRows = await tx.query<{ c: number }>(`SELECT count(*) AS c FROM audit_log`)
      if (Number(existingAuditCountRows[0]?.c ?? 0) === 0) {
        for (const audit of audits) {
          await tx.query(
            `INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              audit.at,
              audit.actor,
              audit.principal_id,
              audit.ip,
              audit.action,
              audit.target,
              audit.detail,
              audit.outcome,
            ],
          )
        }
      }

      await appendAudit(tx, {
        actor: opts.actor ?? 'cli:root',
        action: 'auth.identity_authority_restored',
        target: 'sqlite:identity',
        detail: {
          snapshotSha256: verification.manifest.snapshotSha256,
          restoredPrincipals: principals.length,
          restoredActiveSessions,
          restoredRevokedSessions,
          restoredActiveApiTokens,
          restoredRevokedApiTokens,
          mfaResetCount: mfaResetPrincipalIds.length,
          watermarkEpoch: effectiveWatermark.epoch,
        },
        outcome: 'ok',
      })

      return {
        restoredPrincipals: principals.length,
        restoredActiveSessions,
        restoredRevokedSessions,
        restoredActiveApiTokens,
        restoredRevokedApiTokens,
        mfaResetPrincipalIds,
        effectiveWatermark,
      }
    })
  })

export interface MfaSealKeyRotationResult {
  rotatedPrincipals: Id[]
  revokedSessions: number
  revokedApiTokens: number
  clearedPendingEnrollments: number
  sealKeyFingerprint: string
}

/**
 * Planned MFA sealing secret rotation when `oldServerSecret` is known:
 * unseals every TOTP secret with `oldServerSecret` and reseals with `newServerSecret`
 * in one atomic transaction while preserving `totp_last_step` and `totp_recovery_hashes`.
 */
export const rotateMfaSealKey = (
  db: Db,
  opts: {
    oldServerSecret: string
    newServerSecret: string
    actor?: string
    revokeSessionsAndTokens?: boolean
  },
): Promise<MfaSealKeyRotationResult> =>
  withSqliteErrors(async () => {
    requireValidServerSecret(opts.oldServerSecret, 'oldServerSecret')
    requireStrongServerSecret(opts.newServerSecret, 'newServerSecret')
    if (opts.oldServerSecret === opts.newServerSecret) {
      return fail('VALIDATION', 'newServerSecret must differ from oldServerSecret')
    }

    return db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; username: string; totp_secret_enc: Uint8Array }>(
        `SELECT id, username, totp_secret_enc FROM principals WHERE totp_secret_enc IS NOT NULL ORDER BY id ASC`,
      )
      const now = nowIso()
      const rotatedPrincipals: Id[] = []
      let revokedSessions = 0
      let revokedApiTokens = 0

      for (const row of rows) {
        const plainSecret = unsealTotpSecretWithKey(new Uint8Array(row.totp_secret_enc), opts.oldServerSecret)
        const resealed = sealTotpSecretWithKey(plainSecret, opts.newServerSecret)
        await tx.query(
          `UPDATE principals SET totp_secret_enc = $1, updated_at = $2 WHERE id = $3`,
          [resealed, now, row.id],
        )
        rotatedPrincipals.push(row.id)
        if (opts.revokeSessionsAndTokens !== false) {
          revokedSessions += await revokeAllSessionsForPrincipal(tx, row.id)
          revokedApiTokens += await revokeAllApiTokensForPrincipal(tx, row.id)
        }
      }

      const deletedEnrollments = await tx.query<{ principal_id: string }>(
        `DELETE FROM totp_enrollments RETURNING principal_id`,
      )
      const sealKeyFingerprint = computeSealKeyFingerprint(opts.newServerSecret)

      await appendAudit(tx, {
        actor: opts.actor ?? 'cli:root',
        action: 'auth.mfa_seal_key_rotated',
        target: 'sqlite:identity',
        detail: {
          rotatedCount: rotatedPrincipals.length,
          revokedSessions,
          revokedApiTokens,
          clearedPendingEnrollments: deletedEnrollments.length,
          sealKeyFingerprint,
        },
        outcome: 'ok',
      })

      return {
        rotatedPrincipals,
        revokedSessions,
        revokedApiTokens,
        clearedPendingEnrollments: deletedEnrollments.length,
        sealKeyFingerprint,
      }
    })
  })

export interface MfaSealKeyRecoveryResult {
  recoveredPrincipals: Id[]
  revokedSessions: number
  revokedApiTokens: number
  clearedPendingEnrollments: number
  sealKeyFingerprint: string
  mfaReenrollmentRequired: boolean
}

/**
 * Explicit administrative recovery drill when the MFA sealing secret (`/etc/xpanel/server.secret`)
 * is lost and replaced with `newServerSecret`.
 * Atomically clears undecryptable MFA factors, deletes pending enrollments, and revokes all active
 * sessions and API tokens so affected principals (including `root`) must sign in again.
 * Cleared factors are not required again until that principal enrolls.
 */
export const recoverFromMfaSealKeyLoss = (
  db: Db,
  opts: {
    newServerSecret: string
    actor?: string
    principalIds?: readonly Id[]
    forcePasswordChange?: boolean
  },
): Promise<MfaSealKeyRecoveryResult> =>
  withSqliteErrors(async () => {
    requireStrongServerSecret(opts.newServerSecret, 'newServerSecret')
    const targetIds = opts.principalIds ? opts.principalIds.map((id) => assertId(id, 'principalId')) : null

    return db.transaction(async (tx) => {
      const rows = await tx.query<{
        id: string
        username: string
        totp_secret_enc: Uint8Array | null
        force_password_change: number
      }>(`SELECT id, username, totp_secret_enc, force_password_change FROM principals ORDER BY id ASC`)

      const targetSet = targetIds ? new Set(targetIds) : null
      if (targetSet) {
        const foundIds = new Set(rows.map((r) => r.id))
        for (const id of targetSet) {
          if (!foundIds.has(id)) fail('NOT_FOUND', `principal "${id}" not found`)
        }
      }

      const now = nowIso()
      const recoveredPrincipals: Id[] = []
      let revokedSessions = 0
      let revokedApiTokens = 0

      for (const row of rows) {
        if (targetSet && !targetSet.has(row.id)) continue
        const unsealable =
          row.totp_secret_enc !== null &&
          !canUnsealTotpSecret(new Uint8Array(row.totp_secret_enc), opts.newServerSecret)
        if (!targetSet && !unsealable) continue

        const forceChange = opts.forcePasswordChange ? 1 : row.force_password_change
        await tx.query(
          `UPDATE principals
           SET totp_secret_enc = NULL,
               totp_enabled_at = NULL,
               totp_recovery_hashes = '[]',
               totp_last_step = NULL,
               force_password_change = $1,
               updated_at = $2
           WHERE id = $3`,
          [forceChange, now, row.id],
        )
        recoveredPrincipals.push(row.id)
        revokedSessions += await revokeAllSessionsForPrincipal(tx, row.id)
        revokedApiTokens += await revokeAllApiTokensForPrincipal(tx, row.id)
      }

      const deletedEnrollments = await tx.query<{ principal_id: string }>(
        `DELETE FROM totp_enrollments RETURNING principal_id`,
      )
      const sealKeyFingerprint = computeSealKeyFingerprint(opts.newServerSecret)

      await appendAudit(tx, {
        actor: opts.actor ?? 'cli:root',
        action: 'auth.mfa_seal_key_loss_recovered',
        target: 'sqlite:identity',
        detail: {
          recoveredCount: recoveredPrincipals.length,
          revokedSessions,
          revokedApiTokens,
          clearedPendingEnrollments: deletedEnrollments.length,
          sealKeyFingerprint,
          mfaReenrollmentRequired: true,
        },
        outcome: 'ok',
      })

      return {
        recoveredPrincipals,
        revokedSessions,
        revokedApiTokens,
        clearedPendingEnrollments: deletedEnrollments.length,
        sealKeyFingerprint,
        mfaReenrollmentRequired: true,
      }
    })
  })
